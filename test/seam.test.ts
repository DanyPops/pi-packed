import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { filterRows, formatUpdateNotice, mergeRows, nextMode, visibleRows } from "../extension/src/model.ts";
import { createNatives, type PackageDaemonPort } from "../extension/src/packed.ts";

const installed = [
	{ name: "pi-extension-manager", pinned: "0.8.2" },
	{ name: "pi-lsp", installed: "0.3.0" },
	{ name: "@scope/pkg", pinned: "1.0.0" },
];

describe("model (seam)", () => {
	it("mergeRows joins update info, prefers pinned version", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(rows).toHaveLength(3);
		const lsp = rows.find((row) => row.name === "pi-lsp")!;
		expect(lsp.hasUpdate).toBe(true);
		expect(lsp.latest).toBe("0.4.0");
		expect(lsp.version).toBe("0.3.0");
		const manager = rows.find((row) => row.name === "pi-extension-manager")!;
		expect(manager.hasUpdate).toBe(false);
		expect(manager.version).toBe("0.8.2");
	});

	it("mergeRows sorts by name", () => {
		const rows = mergeRows(installed, []);
		expect(rows.map((row) => row.name)).toEqual(["@scope/pkg", "pi-extension-manager", "pi-lsp"]);
	});

	it("filterRows is case-insensitive substring", () => {
		const rows = mergeRows(installed, []);
		expect(filterRows(rows, "LSP").map((row) => row.name)).toEqual(["pi-lsp"]);
		expect(filterRows(rows, "")).toHaveLength(3);
	});

	it("visibleRows modes", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(visibleRows(rows, "all")).toHaveLength(3);
		expect(visibleRows(rows, "updates").map((row) => row.name)).toEqual(["pi-lsp"]);
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

class FakePackageDaemon implements PackageDaemonPort {
	calls: Array<{ operation: string; input?: unknown }> = [];

	async search(query: string, limit: number, offline = false) {
		this.calls.push({ operation: "search", input: { query, limit, offline } });
		return { query, total: 1, results: [{ name: "pi-lsp", version: "1.0.0" }] };
	}

	async info(name: string) {
		this.calls.push({ operation: "info", input: { name } });
		return { name, version: "1.0.0" };
	}

	async installed() {
		this.calls.push({ operation: "installed" });
		return [{ name: "pi-lsp", pinned: "1.0.0" }];
	}

	async updates() {
		this.calls.push({ operation: "updates" });
		return [{ name: "pi-lsp", installed: "1.0.0", latest: "1.1.0" }];
	}

	async security() {
		this.calls.push({ operation: "security" });
		return { mutationApproval: "always" as const };
	}

	async setMutationApproval(mutationApproval: "always" | "never", approved = false) {
		this.calls.push({ operation: "setMutationApproval", input: { mutationApproval, approved } });
		return { mutationApproval };
	}

	async install(source: string, approved = false) {
		this.calls.push({ operation: "install", input: { source, approved } });
		return `Installed ${source}`;
	}

	async remove(name: string, approved = false) {
		this.calls.push({ operation: "remove", input: { name, approved } });
		return `Removed ${name}`;
	}

	async update(source: string, approved = false) {
		this.calls.push({ operation: "update", input: { source, approved } });
		return `Updated ${source}`;
	}
}

describe("packed extension seam", () => {
	it("routes every operation through the authenticated daemon port", async () => {
		const daemon = new FakePackageDaemon();
		const natives = await createNatives(async () => daemon);

		expect((await natives.search("lsp", 10)).results[0]?.name).toBe("pi-lsp");
		expect((await natives.searchOffline("lsp", 5)).results[0]?.name).toBe("pi-lsp");
		expect((await natives.info("pi-lsp")).version).toBe("1.0.0");
		expect(await natives.installed()).toHaveLength(1);
		expect(await natives.updates()).toHaveLength(1);
		expect((await natives.security()).mutationApproval).toBe("always");
		expect((await natives.setMutationApproval("never", true)).mutationApproval).toBe("never");
		expect(await natives.install("npm:pi-lsp@1.0.0", true)).toContain("Installed");
		expect(await natives.remove("pi-lsp", true)).toContain("Removed");
		expect(await natives.update("npm:pi-lsp", true)).toContain("Updated");
		expect(daemon.calls.map((call) => call.operation)).toEqual([
			"search", "search", "info", "installed", "updates", "security", "setMutationApproval", "install", "remove", "update",
		]);
		expect(daemon.calls[1]?.input).toEqual({ query: "lsp", limit: 5, offline: true });
	});

	it("contains no Bun-only installer or direct SQLite access", () => {
		const source = readFileSync(new URL("../extension/src/packed.ts", import.meta.url), "utf8");
		expect(source).not.toContain("Bun.");
		expect(source).not.toContain("ExecInstaller");
		expect(source).not.toContain("openDb");
		expect(source).not.toContain("db.ts");
	});
});
