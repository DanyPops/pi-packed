import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRun, type CliDeps } from "../src/cli.ts";
import { DaemonRegistry, PackageDaemonClient, PackageDaemonInstaller, probe, resolveRegistry } from "../src/client.ts";
import { createApp } from "../src/service.ts";
import { saveUpdates } from "../src/watcher.ts";
import { openDb, replaceAll, dbPath, catalogList } from "../src/db.ts";
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
	updated = "";
	fail = false;
	approved = false;
	async install(source: string, options?: { approved?: boolean }): Promise<string> {
		this.gotSource = source;
		this.approved = options?.approved === true;
		if (this.fail) throw new Error("installer failed");
		return `Installed ${source}`;
	}
	async remove(source: string, options?: { approved?: boolean }): Promise<string> {
		this.removed = source;
		this.approved = options?.approved === true;
		return `Removed ${source}`;
	}
	async update(source: string, options?: { approved?: boolean }): Promise<string> {
		this.updated = source;
		this.approved = options?.approved === true;
		return `Updated ${source}`;
	}
}

function deps(over: Partial<CliDeps> = {}): CliDeps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		security: {
			async security() { return { mutationApproval: "always" as const }; },
			async setMutationApproval(mutationApproval) { return { mutationApproval }; },
		},
		stateDir: mkdtempSync(join(tmpdir(), "packed-")),
		piHome: mkdtempSync(join(tmpdir(), "packed-pihome-")),
		...over,
	};
}

describe("CLI", () => {
	it("security reads and writes stable JSON through the daemon port", async () => {
		let mutationApproval: "always" | "never" = "always";
		const d = deps({
			security: {
				async security() { return { mutationApproval }; },
				async setMutationApproval(value, options) {
					expect(options?.approved).toBe(true);
					mutationApproval = value;
					return { mutationApproval };
				},
			},
		});
		expect((await cliRun(["security", "--json"], d)).out).toBe('{"mutationApproval":"always"}\n');
		expect((await cliRun(["security", "never", "--approve", "--json"], d)).out).toBe('{"mutationApproval":"never"}\n');
	});

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

	it("updates computes drift from the local mirror", async () => {
		const d = deps();
		writeFileSync(join(d.piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2"] }));
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-extension-manager", version: "0.9.0" }], "test");
		db.close();
		const { code, out } = await cliRun(["updates", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"latest":"0.9.0"');
	});

	it("catalog reads the SQLite mirror", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "a", version: "1" }], "test");
		db.close();
		const { code, out } = await cliRun(["catalog", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"a"');
		expect(out).toContain('"sha256"');
	});

	it("search --offline queries the mirror only", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-lsp", version: "1", description: "LSP tools" }], "test");
		db.close();
		const { code, out } = await cliRun(["search", "lsp", "--offline", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
		expect(out).toContain('"offline":true');
	});

	it("mirror syncs upstream into the local index", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "1" }]) });
		const { code, out } = await cliRun(["mirror", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"synced":1');
		const db = openDb(dbPath(d.stateDir));
		expect(catalogList(db)).toHaveLength(1);
		db.close();
	});

	it("install validates source", async () => {
		const d = deps();
		const { code } = await cliRun(["install", "foo; rm -rf ~"], d);
		expect(code).toBe(2);
		expect((d.inst as FakeInstaller).gotSource).toBe("");
	});

	it("install runs with stable human and JSON output", async () => {
		const d = deps();
		expect((await cliRun(["install", "npm:foo"], d)).code).toBe(1);
		const human = await cliRun(["install", "npm:foo", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("Installed npm:foo");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["install", "npm:foo", "--approve", "--json"], d);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)).toEqual({ ok: true, source: "npm:foo", output: "Installed npm:foo" });
	});

	it("update delegates one configured source with stable output and approval", async () => {
		const d = deps();
		expect((await cliRun(["update", "npm:foo"], d)).code).toBe(1);
		const human = await cliRun(["update", "npm:foo", "--approve"], d);
		expect(human.out).toContain("Updated npm:foo");
		expect((d.inst as FakeInstaller).updated).toBe("npm:foo");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["update", "npm:foo", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({ ok: true, source: "npm:foo", output: "Updated npm:foo", reloadRequired: true });
	});

	it("remove wants a bare name and has stable JSON output", async () => {
		const d = deps();
		expect((await cliRun(["remove", "npm:foo"], d)).code).toBe(2);
		const { code } = await cliRun(["remove", "pi-lsp", "--approve"], d);
		expect(code).toBe(0);
		expect((d.inst as FakeInstaller).removed).toBe("npm:pi-lsp");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["remove", "pi-lsp", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({ ok: true, name: "pi-lsp", output: "Removed npm:pi-lsp" });
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
	let daemonInstaller: FakeInstaller;

	beforeAll(async () => {
		daemonDir = mkdtempSync(join(tmpdir(), "packed-daemon-"));
		writeFileSync(join(daemonDir, "token"), "daemon-tok\n");
		daemonInstaller = new FakeInstaller();
		const app = createApp({
			reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]),
			inst: daemonInstaller,
			token: "daemon-tok",
			stateDir: daemonDir,
			piHome: mkdtempSync(join(tmpdir(), "packed-daemon-pi-")),
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

	it("PackageDaemonClient exposes authenticated install, remove, and package reads", async () => {
		const found = (await probe(daemonDir))!;
		const client = new PackageDaemonClient(found.base, found.token);
		expect((await client.search("lsp", 10)).results[0]?.name).toBe("pi-lsp");
		expect((await client.info("pi-lsp")).version).toBe("1.0.0");
		expect(await client.installed()).toEqual([]);
		expect(await client.updates()).toEqual([]);
		expect(await client.security()).toEqual({ mutationApproval: "always" });
		await expect(client.install("npm:pi-lsp")).rejects.toThrow("approval required");
		expect(await client.install("npm:pi-lsp", true)).toBe("Installed npm:pi-lsp");
		expect(await client.remove("pi-lsp", true)).toBe("Removed npm:pi-lsp");
		expect(await client.update("npm:pi-lsp", true)).toBe("Updated npm:pi-lsp");
		const installer = new PackageDaemonInstaller(client);
		expect(await installer.install("npm:pi-lsp@1.0.0", { approved: true })).toBe("Installed npm:pi-lsp@1.0.0");
		expect(await installer.remove("npm:pi-lsp", { approved: true })).toBe("Removed npm:pi-lsp");
		expect(await installer.update("npm:pi-lsp", { approved: true })).toBe("Updated npm:pi-lsp");
		expect(await client.setMutationApproval("never", true)).toEqual({ mutationApproval: "never" });
		expect(daemonInstaller.gotSource).toBe("npm:pi-lsp@1.0.0");
		expect(daemonInstaller.removed).toBe("npm:pi-lsp");

		daemonInstaller.fail = true;
		await expect(client.install("npm:missing")).rejects.toThrow("installer failed");
		daemonInstaller.fail = false;
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
		const d = deps({ execPath: "/usr/bin/bun", cliPath: "/opt/pi-packed/src/cli.ts", piBin: "/home/x/.cache/.bun/bin/pi" });
		const { code, out } = await cliRun(["service"], d);
		expect(code).toBe(0);
		expect(out).toContain("[Service]");
		expect(out).toContain("ExecStart=/usr/bin/bun /opt/pi-packed/src/cli.ts serve");
		expect(out).toContain("Restart=on-failure");
		expect(out).toContain("PI_PACKED_IDLE_SECS=0");
		expect(out).toContain("Environment=PI_BIN=/home/x/.cache/.bun/bin/pi");
		expect(out).toContain("WantedBy=default.target");
	});
});
