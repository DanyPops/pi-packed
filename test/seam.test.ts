import { describe, it, expect, mock, beforeEach } from "bun:test";
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

// packed.ts exec wrapper — child_process mocked.
let execBehavior: { stdout?: string; stderr?: string; fail?: boolean };
mock.module("node:child_process", () => ({
	execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
		if (execBehavior.fail) cb(new Error("spawn failed"), "", execBehavior.stderr ?? "");
		else cb(null, execBehavior.stdout ?? "{}", execBehavior.stderr ?? "");
	},
}));

describe("packed (seam exec wrapper)", () => {
	beforeEach(() => {
		execBehavior = {};
	});

	it("runPacked parses JSON output", async () => {
		execBehavior.stdout = '{"total":1,"results":[]}';
		const { runPacked } = await import("../extension/src/packed.ts");
		const r = await runPacked<{ total: number }>(["search", "x"]);
		expect(r.total).toBe(1);
	});

	it("runPacked rejects invalid JSON with context", async () => {
		execBehavior.stdout = "not json at all";
		const { runPacked } = await import("../extension/src/packed.ts");
		expect(runPacked(["search", "x"])).rejects.toThrow(/invalid JSON/);
	});

	it("runPackedText returns combined output", async () => {
		execBehavior.stdout = "Installed npm:foo";
		const { runPackedText } = await import("../extension/src/packed.ts");
		expect(await runPackedText(["install", "npm:foo"])).toBe("Installed npm:foo");
	});

	it("cliPath honors PACKED_CLI override", async () => {
		process.env["PACKED_CLI"] = "/custom/cli.ts";
		const { cliPath } = await import("../extension/src/packed.ts");
		expect(cliPath()).toBe("/custom/cli.ts");
		delete process.env["PACKED_CLI"];
	});
});
