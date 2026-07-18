/**
 * registry.ts — driven adapter: npm registry over HTTP (web-standard fetch).
 * Lean mapping = Facade over npm's verbose package documents.
 */
import type { Pkg, PkgInfo, Registry, SearchPage } from "./ports.ts";
import {
	NPM_REGISTRY_BASE, SEARCH_PAGE_SIZE, RETRY_MAX_ATTEMPTS, RETRY_BASE_DELAY_MS, PAGE_DELAY_MS,
} from "./constants.ts";
import { createLogger } from "./log.ts";

const log = createLogger("registry");

/** Upstream etiquette: honor Retry-After on 429, exponential backoff
 * otherwise, give up after RETRY_MAX_ATTEMPTS. */
async function fetchWithRetry(url: string, init: RequestInit | undefined, baseDelayMs: number): Promise<Response> {
	let lastErr: Error | undefined;
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
		const t0 = Date.now();
		try {
			const res = await fetch(url, init);
			const ms = Date.now() - t0;
			if (res.status === 429 && attempt < RETRY_MAX_ATTEMPTS) {
				const ra = res.headers.get("retry-after");
				const delayMs =
					ra !== null && Number(ra) > 0
						? Number(ra) * 1000 // authoritative only when positive
						: baseDelayMs * 2 ** (attempt - 1); // npm sends 0: use exponential
				log.warn("429 rate-limited, backing off", { attempt, delayMs, ms, url: url.slice(0, 120) });
				await Bun.sleep(delayMs);
				continue;
			}
			log.debug("fetch", { status: res.status, ms, attempt, url: url.slice(0, 120) });
			return res;
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			log.warn("fetch error, retrying", { attempt, error: lastErr.message, url: url.slice(0, 120) });
			if (attempt < RETRY_MAX_ATTEMPTS) await Bun.sleep(baseDelayMs * 2 ** (attempt - 1));
		}
	}
	log.error("retry budget exhausted", { attempts: RETRY_MAX_ATTEMPTS, url: url.slice(0, 120) });
	throw lastErr ?? new Error("retry budget exhausted");
}

export class HttpRegistry implements Registry {
	constructor(
		private base = NPM_REGISTRY_BASE,
		private pageSize = SEARCH_PAGE_SIZE,
		private pageDelayMs = PAGE_DELAY_MS,
		private retryBaseDelayMs = RETRY_BASE_DELAY_MS,
	) {}

	async search(query: string, limit: number): Promise<SearchPage> {
		return this.searchPage(query, 0, limit);
	}

	async searchPage(query: string, from: number, size: number): Promise<SearchPage> {
		const params = new URLSearchParams({ text: query, size: String(size), from: String(from) });
		const res = await fetchWithRetry(`${this.base}/-/v1/search?${params}`, undefined, this.retryBaseDelayMs);
		if (!res.ok) throw new Error(`npm search: HTTP ${res.status}`);
		const doc = (await res.json()) as {
			total?: number;
			objects?: { package?: { name?: string; version?: string; description?: string; date?: string } }[];
		};
		const results: Pkg[] = (doc.objects ?? []).flatMap((o) => {
			const p = o.package;
			return p?.name
				? [{ name: p.name, version: p.version ?? "", description: p.description, date: p.date }]
				: [];
		});
		return { results, total: doc.total ?? results.length };
	}

	async searchAll(query: string): Promise<Pkg[]> {
		// Map by name: npm's ranking shifts mid-pagination and a package can
		// appear on two pages — first occurrence wins.
		const byName = new Map<string, Pkg>();
		let from = 0;
		for (;;) {
			if (from > 0 && this.pageDelayMs > 0) await Bun.sleep(this.pageDelayMs);
			const { results, total } = await this.searchPage(query, from, this.pageSize);
			if (results.length === 0 || from >= total) break;
			for (const p of results) {
				if (!byName.has(p.name)) byName.set(p.name, p);
			}
			from += results.length;
		}
		return [...byName.values()];
	}

	async info(name: string): Promise<PkgInfo> {
		const res = await fetchWithRetry(
			`${this.base}/${encodeURIComponent(name).replace("%2F", "/")}`,
			{ headers: { accept: "application/vnd.npm.install-v1+json" } },
			this.retryBaseDelayMs,
		);
		if (!res.ok) throw new Error(`npm info ${name}: HTTP ${res.status}`);
		const doc = (await res.json()) as {
			name?: string;
			"dist-tags"?: Record<string, string>;
			versions?: Record<
				string,
				{
					version?: string;
					description?: string;
					homepage?: string;
					license?: unknown;
					repository?: unknown;
					keywords?: string[];
					pi?: Record<string, unknown>;
					dist?: { unpackedSize?: number };
				}
			>;
			time?: Record<string, string>;
		};
		const latest = doc["dist-tags"]?.["latest"] ?? "";
		const v = doc.versions?.[latest];
		if (!v) throw new Error(`npm info ${name}: version ${latest} not in document`);
		return {
			name: doc.name ?? name,
			version: v.version ?? latest,
			description: v.description,
			homepage: v.homepage,
			repository: rawToString(v.repository, "url"),
			license: rawToString(v.license, "type"),
			keywords: v.keywords,
			pi: v.pi,
			modified: doc.time?.["modified"],
			unpackedSize: v.dist?.unpackedSize,
		};
	}
}

/** npm fields appear as plain string OR object: license: "MIT" | {type:"MIT"}. */
function rawToString(raw: unknown, objKey: string): string | undefined {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object") {
		const v = (raw as Record<string, unknown>)[objKey];
		if (typeof v === "string") return v;
	}
	return undefined;
}
