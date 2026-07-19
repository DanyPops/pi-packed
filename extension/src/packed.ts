/**
 * packed.ts — thin Pi extension seam over the authenticated package daemon.
 *
 * Pi's extension runtime is Node-compatible and does not guarantee a global
 * `Bun`. All registry reads, SQLite access, and package mutations therefore
 * stay inside the supervised Bun daemon. The seam reconnects for every call so
 * a restarted daemon cannot leave a stale port/token client cached in Pi.
 */
import type { PackageDaemonPort as ClientPackageDaemonPort } from "../../src/client.ts";
import type { InstalledPkg, Pkg, PkgInfo, UpdateEntry } from "../../src/ports.ts";
import type { InstallApproval, SecuritySettings } from "../../src/security.ts";

export type { InstalledPkg, UpdateEntry };
export type PackageInfo = PkgInfo;
export type PackageDaemonPort = ClientPackageDaemonPort;

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
	security(): Promise<SecuritySettings>;
	setInstallApproval(value: InstallApproval): Promise<SecuritySettings>;
	install(source: string): Promise<string>;
	remove(name: string): Promise<string>;
}

export type PackageDaemonConnector = () => Promise<PackageDaemonPort>;

async function connectDefaultDaemon(): Promise<PackageDaemonPort> {
	const [client, state] = await Promise.all([
		import("../../src/client.ts"),
		import("../../src/state.ts"),
	]);
	return client.connectPackageDaemon(state.stateDir());
}

export async function createNatives(connect: PackageDaemonConnector = connectDefaultDaemon): Promise<Natives> {
	async function call<T>(operation: (daemon: PackageDaemonPort) => Promise<T>): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await operation(await connect());
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	return {
		search: (query, limit) => call((daemon) => daemon.search(query, limit)),
		searchOffline: (query, limit) => call((daemon) => daemon.search(query, limit, true)),
		info: (name) => call((daemon) => daemon.info(name)),
		installed: () => call((daemon) => daemon.installed()),
		updates: () => call((daemon) => daemon.updates()),
		security: () => call((daemon) => daemon.security()),
		setInstallApproval: (value) => call((daemon) => daemon.setInstallApproval(value)),
		install: (source) => call((daemon) => daemon.install(source)),
		remove: (name) => call((daemon) => daemon.remove(name)),
	};
}
