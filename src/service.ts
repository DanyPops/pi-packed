/**
 * service.ts — the hexagon's HTTP driving adapter as a pure Web Standard
 * handler: (Request) → Response. Bun.serve wraps it for the network;
 * tests call it in-process. Same port, two adapters — Cockburn's symmetry.
 */
import { buildSearchQuery, clampLimit } from "./ports.ts";
import type { Installer, Registry } from "./ports.ts";
import { TTLCache } from "./cache.ts";
import { loadUpdates } from "./watcher.ts";
import { readInstalledPackages, defaultPiHome } from "./installed.ts";
import { openDb, searchLocal, catalogList, getSyncMeta, dbPath } from "./db.ts";
import { VERSION, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "./constants.ts";
import { createLogger } from "./log.ts";

const log = createLogger("service");

export interface Deps {
	reg: Registry;
	inst: Installer;
	token: string;
	stateDir: string;
	piHome?: string;
	cache?: TTLCache;
}

const SOURCE_RE = /^(npm:[A-Za-z0-9@._/-]+|git:[A-Za-z0-9@:._/-]+|https:\/\/[A-Za-z0-9@:._/?=&%~-]+)$/;
const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

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
			return json({ ok: true, version: VERSION });
		}

		if (path === "/search" && req.method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const limit = clampLimit(Number(url.searchParams.get("limit")), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
			// offline=1: serve from the SQLite mirror (apt-cache search analog)
			if (url.searchParams.get("offline") === "1") {
				const db = openDb(dbPath(deps.stateDir));
				try {
					const results = searchLocal(db, q, limit);
					return json({ query: q, total: results.length, results, offline: true });
				} finally {
					db.close();
				}
			}
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

		if (path === "/installed" && req.method === "GET") {
			return json(readInstalledPackages(deps.piHome ?? defaultPiHome()));
		}

		if (path === "/remove" && req.method === "POST") {
			let name = "";
			try {
				const body = (await req.json()) as { name?: unknown };
				name = String(body.name ?? "");
			} catch {
				/* fall through to validation */
			}
			if (!NAME_RE.test(name)) {
				return err(400, "invalid name; want a bare npm package name");
			}
			try {
				const output = await deps.inst.remove(`npm:${name}`);
				return json({ ok: true, name, output });
			} catch (e) {
				return json({ ok: false, name, output: e instanceof Error ? e.message : String(e) });
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
			const db = openDb(dbPath(deps.stateDir));
			try {
				const meta = getSyncMeta(db);
				return json({ fetchedAt: meta?.fetchedAt, sha256: meta?.sha256, packages: catalogList(db) });
			} finally {
				db.close();
			}
		}

		return err(404, "not found");
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const t0 = Date.now();
			if (req.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return err(401, "missing or invalid bearer token");
			}
			// Cache successful GETs by URI (smart-proxy concern).
			if (req.method === "GET" && !["/health", "/updates", "/catalog"].includes(new URL(req.url).pathname)) {
				const hit = cache.get(req.url);
				if (hit) {
					log.debug("request", { path: new URL(req.url).pathname, cache: "hit", ms: Date.now() - t0 });
					return new Response(hit, { headers: { "content-type": "application/json", "x-cache": "hit" } });
				}
				const res = await route(req);
				if (res.status === 200) cache.set(req.url, await res.clone().text());
				log.debug("request", { path: new URL(req.url).pathname, status: res.status, cache: "miss", ms: Date.now() - t0 });
				return res;
			}
			const res = await route(req);
			log.debug("request", { path: new URL(req.url).pathname, status: res.status, ms: Date.now() - t0 });
			return res;
		},
	};
}
