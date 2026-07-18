import { describe, it, expect } from "bun:test";
import { mergeRows, filterRows, visibleRows, nextMode, formatUpdateNotice } from "../extension/src/model.ts";

describe("model (seam)", () => {
	const installed = [
		{ name: "pi-extension-manager", pinned: "0.8.2" },
		{ name: "pi-lsp", installed: "0.3.0" },
		{ name: "@scope/pkg", pinned: "1.0.0" },
	];

	it("mergeRows joins update info, prefers pinned version", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(rows).toHaveLength(3);
		const lsp = rows.find((r) => r.name === "pi-lsp")!;
		expect(lsp.hasUpdate).toBe(true);
		expect(lsp.latest).toBe("0.4.0");
		expect(lsp.version).toBe("0.3.0");
		const em = rows.find((r) => r.name === "pi-extension-manager")!;
		expect(em.hasUpdate).toBe(false);
		expect(em.version).toBe("0.8.2");
	});

	it("mergeRows sorts by name", () => {
		const rows = mergeRows(installed, []);
		expect(rows.map((r) => r.name)).toEqual(["@scope/pkg", "pi-extension-manager", "pi-lsp"]);
	});

	it("filterRows is case-insensitive substring", () => {
		const rows = mergeRows(installed, []);
		expect(filterRows(rows, "LSP").map((r) => r.name)).toEqual(["pi-lsp"]);
		expect(filterRows(rows, "")).toHaveLength(3);
	});

	it("visibleRows modes", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(visibleRows(rows, "all")).toHaveLength(3);
		expect(visibleRows(rows, "updates").map((r) => r.name)).toEqual(["pi-lsp"]);
		expect(nextMode("all")).toBe("updates");
		expect(nextMode("updates")).toBe("all");
	});

	it("formatUpdateNotice truncates long lists", () => {
		const updates = [
			{ name: "a", installed: "1", latest: "2" },
			{ name: "b", installed: "1", latest: "2" },
			{ name: "c", installed: "1", latest: "2" },
			{ name: "d", installed: "1", latest: "2" },
		];
		expect(formatUpdateNotice(updates)).toBe("4 package update(s): a 1→2, b 1→2, c 1→2 +1 more");
	});
});

// packed.ts native client — temp env + real SQLite mirror.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, replaceAll, dbPath } from "../src/db.ts";
import { createNatives } from "../extension/src/packed.ts";
import type { Pkg } from "../src/ports.ts";

const savedEnv = { home: process.env["PI_PACKED_HOME"], pi: process.env["PI_PACKED_PI_HOME"] };
function restoreEnv(): void {
	if (savedEnv.home === undefined) delete process.env["PI_PACKED_HOME"];
	else process.env["PI_PACKED_HOME"] = savedEnv.home;
	if (savedEnv.pi === undefined) delete process.env["PI_PACKED_PI_HOME"];
	else process.env["PI_PACKED_PI_HOME"] = savedEnv.pi;
}

describe("packed natives (in-process)", () => {
	function setupEnv(pkgs: Pkg[]) {
		const stateDir = mkdtempSync(join(tmpdir(), "packed-seam-"));
		const piHome = mkdtempSync(join(tmpdir(), "packed-seam-pi-"));
		writeFileSync(
			join(piHome, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2"] }),
		);
		const db = openDb(dbPath(stateDir));
		replaceAll(db, pkgs, "test");
		db.close();
		process.env["PI_PACKED_HOME"] = stateDir;
		process.env["PI_PACKED_PI_HOME"] = piHome;
	}

	it("updates() computes drift from the mirror, in-process", async () => {
		setupEnv([{ name: "pi-extension-manager", version: "0.9.0" }]);
		const natives = await createNatives();
		const updates = await natives.updates();
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ name: "pi-extension-manager", installed: "0.8.2", latest: "0.9.0" });
		restoreEnv();
	});

	it("installed() reads pi settings, in-process", async () => {
		setupEnv([]);
		const natives = await createNatives();
		const installed = await natives.installed();
		expect(installed).toEqual([{ name: "pi-extension-manager", pinned: "0.8.2", installed: undefined }]);
		restoreEnv();
	});

	it("searchOffline() queries the mirror via FTS", async () => {
		setupEnv([{ name: "pi-lsp", version: "1", description: "LSP tools" }]);
		const natives = await createNatives();
		const r = await natives.searchOffline("lsp", 10);
		expect(r.results.map((p) => p.name)).toEqual(["pi-lsp"]);
		restoreEnv();
	});
});
