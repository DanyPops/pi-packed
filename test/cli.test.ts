import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRun, type CliDeps } from "../src/cli.ts";
import { DaemonRegistry, probe, resolveRegistry } from "../src/client.ts";
import { createApp } from "../src/service.ts";
import { saveUpdates } from "../src/watcher.ts";
import { saveCatalog } from "../src/catalog.ts";
import { HttpRegistry } from "../src/registry.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage } from "../src/ports.ts";
import type { Server } from "bun";

class FakeRegistry implements Registry {
	constructor(private results: Pkg[] = [], private versions: Record<string, string> = {}) {}
	async search(_q: string, _limit: number): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchAll(): Promise<import("../src/ports.ts").Pkg[]> {
		return this.results;
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: this.versions[name] ?? "1.0.0", description: "desc" };
	}
}

class FakeInstaller implements Installer {
	gotSource = "";
	removed = "";
	async install(source: string): Promise<string> {
		this.gotSource = source;
		return `Installed ${source}`;
	}
	async remove(source: string): Promise<string> {
		this.removed = source;
		return `Removed ${source}`;
	}
}

function deps(over: Partial<CliDeps> = {}): CliDeps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		stateDir: mkdtempSync(join(tmpdir(), "packed-")),
		piHome: mkdtempSync(join(tmpdir(), "packed-pihome-")),
		...over,
	};
}

describe("CLI", () => {
	it("search --json", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]) });
		const { code, out } = await cliRun(["search", "lsp", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
	});

	it("search human", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0", description: "LSP" }]) });
		const { code, out } = await cliRun(["search", "lsp"], d);
		expect(code).toBe(0);
		expect(out).toContain("pi-lsp@0.3.0");
		expect(out).toContain("LSP");
	});

	it("info --json", async () => {
		const { code, out } = await cliRun(["info", "pi-lsp", "--json"], deps());
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
	});

	it("installed --json (string and object settings forms)", async () => {
		const d = deps();
		writeFileSync(
			join(d.piHome, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2", { source: "npm:obj@2.0.0" }] }),
		);
		const { code, out } = await cliRun(["installed", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-extension-manager"');
		expect(out).toContain('"pinned":"0.8.2"');
	});

	it("updates --cached reads snapshot, no registry calls", async () => {
		const d = deps();
		await saveUpdates(d.stateDir, {
			checkedAt: new Date().toISOString(),
			updates: [{ name: "a", installed: "1", latest: "2", detectedAt: "" }],
		});
		const { code, out } = await cliRun(["updates", "--cached", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"latest":"2"');
	});

	it("catalog reads snapshot", async () => {
		const d = deps();
		await saveCatalog(d.stateDir, { fetchedAt: new Date().toISOString(), packages: [{ name: "a", version: "1" }] });
		const { code, out } = await cliRun(["catalog", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"a"');
	});

	it("install validates source", async () => {
		const d = deps();
		const { code } = await cliRun(["install", "foo; rm -rf ~"], d);
		expect(code).toBe(2);
		expect((d.inst as FakeInstaller).gotSource).toBe("");
	});

	it("install runs", async () => {
		const d = deps();
		const { code, out } = await cliRun(["install", "npm:foo"], d);
		expect(code).toBe(0);
		expect(out).toContain("Installed npm:foo");
	});

	it("remove wants bare name", async () => {
		const d = deps();
		expect((await cliRun(["remove", "npm:foo"], d)).code).toBe(2);
		const { code } = await cliRun(["remove", "pi-lsp"], d);
		expect(code).toBe(0);
		expect((d.inst as FakeInstaller).removed).toBe("npm:pi-lsp");
	});

	it("unknown command → usage, code 2", async () => {
		const { code, out } = await cliRun(["frobnicate"], deps());
		expect(code).toBe(2);
		expect(out).toContain("usage");
	});
});

describe("daemon client", () => {
	let server: Server<undefined>;
	let daemonDir: string;

	beforeAll(async () => {
		daemonDir = mkdtempSync(join(tmpdir(), "packed-daemon-"));
		writeFileSync(join(daemonDir, "token"), "daemon-tok\n");
		const app = createApp({
			reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]),
			inst: new FakeInstaller(),
			token: "daemon-tok",
			stateDir: daemonDir,
		});
		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
		writeFileSync(join(daemonDir, "port"), `${server.port}\n`);
	});
	afterAll(() => server.stop(true));

	it("probe finds a live daemon", async () => {
		const found = await probe(daemonDir);
		expect(found).toBeDefined();
		expect(found?.token).toBe("daemon-tok");
	});

	it("probe rejects dead state", async () => {
		expect(await probe(mkdtempSync(join(tmpdir(), "packed-")))).toBeUndefined();
	});

	it("DaemonRegistry proxies search/info over HTTP with auth", async () => {
		const found = (await probe(daemonDir))!;
		const reg = new DaemonRegistry(found.base, found.token);
		const { results } = await reg.search("keywords:pi-package lsp", 10);
		expect(results[0]?.name).toBe("pi-lsp");
		const info = await reg.info("pi-lsp");
		expect(info.name).toBe("pi-lsp");
	});

	it("resolveRegistry prefers daemon, falls back direct", async () => {
		const viaDaemon = await resolveRegistry(daemonDir, "https://registry.npmjs.org");
		expect(viaDaemon).toBeInstanceOf(DaemonRegistry);
		const direct = await resolveRegistry(mkdtempSync(join(tmpdir(), "packed-")), "https://registry.npmjs.org");
		expect(direct).toBeInstanceOf(HttpRegistry);
	});
});

describe("packed service (systemd unit)", () => {
	it("renders a user unit with runtime paths and idle disabled", async () => {
		const d = deps({ execPath: "/usr/bin/bun", cliPath: "/opt/pi-packed/src/cli.ts" });
		const { code, out } = await cliRun(["service"], d);
		expect(code).toBe(0);
		expect(out).toContain("[Service]");
		expect(out).toContain("ExecStart=/usr/bin/bun /opt/pi-packed/src/cli.ts serve");
		expect(out).toContain("Restart=on-failure");
		expect(out).toContain("PI_PACKED_IDLE_SECS=0");
		expect(out).toContain("WantedBy=default.target");
	});
});
