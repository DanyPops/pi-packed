/**
 * packed.ts — native library client. The seam imports the pi-packed service
 * modules IN-PROCESS (web-spider's pattern: dynamic import() bypasses jiti's
 * CJS interop, which can drop class constructors for "type":"module" packages).
 *
 * The SQLite mirror is the shared substrate (WAL: the daemon writes, we read
 * concurrently). The daemon remains the background producer; the seam works
 * even with the daemon down. No subprocess, no token/port files.
 */
import type { Db } from "../../src/db.ts";
import type { InstalledPkg, Pkg, PkgInfo, UpdateEntry } from "../../src/ports.ts";

export type { InstalledPkg, UpdateEntry };
export type PackageInfo = PkgInfo;
export interface SearchResponse {
	query: string;
	total: number;
	results: Pkg[];
}

export interface Natives {
	search(query: string, limit: number): Promise<SearchResponse>;
	searchOffline(query: string, limit: number): Promise<SearchResponse>;
	info(name: string): Promise<PackageInfo>;
	installed(): Promise<InstalledPkg[]>;
	updates(): Promise<UpdateEntry[]>;
	install(source: string): Promise<string>;
	remove(name: string): Promise<string>;
}

export async function createNatives(): Promise<Natives> {
	const [dbMod, regMod, instMod, watchMod, execMod, stateMod, portsMod] = await Promise.all([
		import("../../src/db.ts"),
		import("../../src/registry.ts"),
		import("../../src/installed.ts"),
		import("../../src/watcher.ts"),
		import("../../src/install.ts"),
		import("../../src/state.ts"),
		import("../../src/ports.ts"),
	]);

	const reg = new regMod.HttpRegistry();
	const inst = new execMod.ExecInstaller();

	// Per-call open/close: lifecycle-clean (no held handles, safe with the
	// daemon writing concurrently under WAL).
	function withDb<T>(fn: (db: Db) => T): T {
		const db = dbMod.openDb(dbMod.dbPath(stateMod.stateDir()));
		try {
			return fn(db);
		} finally {
			db.close();
		}
	}

	return {
		async search(query, limit) {
			const { results, total } = await reg.search(portsMod.buildSearchQuery(query), limit);
			return { query, total, results };
		},
		async searchOffline(query, limit) {
			const results = withDb((db) => dbMod.searchLocal(db, query, limit));
			return { query, total: results.length, results };
		},
		info: (name) => reg.info(name),
		installed: () => Promise.resolve(instMod.readInstalledPackages(instMod.defaultPiHome())),
		updates: () =>
			Promise.resolve(
				withDb((db) =>
					watchMod.checkUpdates(
						(name) => dbMod.latestVersion(db, name),
						instMod.readInstalledPackages(instMod.defaultPiHome()),
					),
				),
			),
		install: (source) => inst.install(source),
		remove: (name) => inst.remove(`npm:${name}`),
	};
}
