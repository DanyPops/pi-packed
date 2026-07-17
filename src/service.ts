/**
 * service.ts — the hexagon's HTTP driving adapter as a pure Web Standard
 * handler: (Request) → Response. Bun.serve wraps it for the network;
 * tests call it in-process. Same port, two adapters — Cockburn's symmetry.
 */
import { buildSearchQuery, clampLimit } from "./ports.ts";
import type { Installer, Registry } from "./ports.ts";
import { TTLCache } from "./cache.ts";
import { loadUpdates } from "./watcher.ts";
import { loadCatalog } from "./catalog.ts";

export interface Deps {
	reg: Registry;
	inst: Installer;
	token: string;
	stateDir: string;
	cache?: TTLCache;
}

const SOURCE_RE = /^(npm:[A-Za-z0-9@._/-]+|git:[A-Za-z0-9@:._/-]+|https:\/\/[A-Za-z0-9@:._/?=&%~-]+)$/;

function json(v: unknown, init?: ResponseInit): Response {
	return Response.json(v, init);
}

function err(status: number, msg: string): Response {
	return json({ error: msg }, { status });
}

export function createApp(deps: Deps): { fetch: (req: Request) => Promise<Response> } {
	const cache = deps.cache ?? new TTLCache();

	async function route(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;

		if (path === "/health" && req.method === "GET") {
			return json({ ok: true, version: "0.1.0" });
		}

		if (path === "/search" && req.method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const limit = clampLimit(Number(url.searchParams.get("limit")), 10, 50);
			try {
				const { results, total } = await deps.reg.search(buildSearchQuery(q), limit);
				return json({ query: q, total, results });
			} catch (e) {
				return err(502, e instanceof Error ? e.message : String(e));
			}
		}

		if (path === "/info" && req.method === "GET") {
			const name = url.searchParams.get("name") ?? "";
			if (!name) return err(400, "missing name");
			try {
				return json(await deps.reg.info(name));
			} catch (e) {
				return err(502, e instanceof Error ? e.message : String(e));
			}
		}

		if (path === "/install" && req.method === "POST") {
			let source = "";
			try {
				const body = (await req.json()) as { source?: unknown };
				source = String(body.source ?? "");
			} catch {
				/* fall through to validation */
			}
			if (!SOURCE_RE.test(source)) {
				return err(400, "invalid source; want npm:<pkg>[@ver], git:<host>/<owner>/<repo>[@ref], or https://…");
			}
			try {
				const output = await deps.inst.install(source);
				return json({ ok: true, source, output });
			} catch (e) {
				return json({ ok: false, source, output: e instanceof Error ? e.message : String(e) });
			}
		}

		if (path === "/updates" && req.method === "GET") {
			const snap = await loadUpdates(deps.stateDir);
			return json(snap ?? { updates: [] });
		}

		if (path === "/catalog" && req.method === "GET") {
			const snap = await loadCatalog(deps.stateDir);
			return json(snap ?? { packages: [] });
		}

		return err(404, "not found");
	}

	return {
		async fetch(req: Request): Promise<Response> {
			if (req.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return err(401, "missing or invalid bearer token");
			}
			// Cache successful GETs by URI (smart-proxy concern).
			if (req.method === "GET" && !["/health", "/updates", "/catalog"].includes(new URL(req.url).pathname)) {
				const hit = cache.get(req.url);
				if (hit) {
					return new Response(hit, { headers: { "content-type": "application/json", "x-cache": "hit" } });
				}
				const res = await route(req);
				if (res.status === 200) cache.set(req.url, await res.clone().text());
				return res;
			}
			return route(req);
		},
	};
}
