import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPackages, splitNpmSource } from "../src/installed.ts";
import { checkUpdates, saveUpdates, loadUpdates, startWatcher } from "../src/watcher.ts";
import { catalogStatus } from "../src/catalog.ts";
import { openDb, replaceAll } from "../src/db.ts";
import type { PkgInfo, Registry, SearchPage } from "../src/ports.ts";

class FakeRegistry implements Registry {
	infoCalls = 0;
	constructor(
		private versions: Record<string, string> = {},
		private pages: Record<number, SearchPage> = {},
	) {}
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(_q: string, from: number, _size?: number): Promise<SearchPage> {
		return this.pages[from] ?? { results: [], total: 0 };
	}
	async searchAll(q: string): Promise<import("../src/ports.ts").Pkg[]> {
		const out: import("../src/ports.ts").Pkg[] = [];
		let from = 0;
		for (;;) {
			const { results, total } = await this.searchPage(q, from, 0);
			out.push(...results);
			from += results.length;
			if (results.length === 0 || from >= total) return out;
		}
	}
	async info(name: string): Promise<PkgInfo> {
		this.infoCalls++;
		const v = this.versions[name];
		if (!v) throw new Error(`404 ${name}`);
		return { name, version: v };
	}
}

function writePiHome(settings: unknown, nodeModules: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "packed-pihome-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	for (const [name, version] of Object.entries(nodeModules)) {
		const pkgDir = join(dir, "npm", "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
	}
	return dir;
}

describe("splitNpmSource", () => {
	it("splits on last non-scope @", () => {
		expect(splitNpmSource("foo@1.2.3")).toEqual(["foo", "1.2.3"]);
		expect(splitNpmSource("@scope/pkg@1.0.0")).toEqual(["@scope/pkg", "1.0.0"]);
		expect(splitNpmSource("foo")).toEqual(["foo", ""]);
		expect(splitNpmSource("@scope/pkg")).toEqual(["@scope/pkg", ""]);
	});
});

describe("readInstalledPackages", () => {
	it("parses string and object forms, resolves unpinned from node_modules", () => {
		const home = writePiHome(
			{
				packages: [
					"npm:pi-extension-manager@0.8.2",
					"npm:@scope/pinned@1.0.0",
					"npm:unpinned",
					"git:github.com/u/r",
					{ source: "npm:obj-form@2.0.0" },
				],
			},
			{ unpinned: "0.5.0" },
		);
		expect(readInstalledPackages(home)).toEqual([
			{ name: "pi-extension-manager", pinned: "0.8.2", installed: undefined },
			{ name: "@scope/pinned", pinned: "1.0.0", installed: undefined },
			{ name: "unpinned", pinned: undefined, installed: "0.5.0" },
			{ name: "obj-form", pinned: "2.0.0", installed: undefined },
		]);
	});

	it("missing settings → empty", () => {
		expect(readInstalledPackages(mkdtempSync(join(tmpdir(), "packed-")))).toEqual([]);
	});
});

describe("checkUpdates (mirror-based)", () => {
	it("flags drift only", () => {
		const latest = (name: string) => ({ "pi-extension-manager": "0.9.0", "pi-lsp": "1.0.0" })[name];
		const updates = checkUpdates(latest, [
			{ name: "pi-extension-manager", pinned: "0.8.2" },
			{ name: "pi-lsp", installed: "1.0.0" },
		]);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ name: "pi-extension-manager", installed: "0.8.2", latest: "0.9.0" });
	});

	it("packages missing from the mirror are skipped", () => {
		const updates = checkUpdates(() => undefined, [{ name: "gone", pinned: "1.0.0" }]);
		expect(updates).toEqual([]);
	});
});

describe("updates store", () => {
	it("roundtrips", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		const snap = { checkedAt: new Date().toISOString(), updates: [{ name: "a", installed: "1", latest: "2", detectedAt: "" }] };
		await saveUpdates(dir, snap);
		expect(await loadUpdates(dir)).toEqual(snap);
		expect(await loadUpdates(join(dir, "nope"))).toBeUndefined();
	});
});

describe("watcher producer", () => {
	it("writes a snapshot on tick", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		const stop = startWatcher(
			() => "0.9.0",
			dir,
			() => [{ name: "pi-extension-manager", pinned: "0.8.2" }],
			{ intervalMs: 60_000 },
		);
		const deadline = Date.now() + 2000;
		let snap;
		while (Date.now() < deadline) {
			snap = await loadUpdates(dir);
			if (snap?.updates.length) break;
			await Bun.sleep(25);
		}
		stop();
		expect(snap?.updates[0]?.latest).toBe("0.9.0");
	});
});

describe("catalog status", () => {
	it("stale when unsynced, fresh after sync", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		expect(catalogStatus(dir, 6 * 3_600_000).stale).toBe(true);
		const db = openDb(dir + "/packed.db");
		replaceAll(db, [{ name: "a", version: "1" }], "test");
		db.close();
		expect(catalogStatus(dir, 6 * 3_600_000).stale).toBe(false);
		expect(catalogStatus(dir, -1).stale).toBe(true);
	});
});
