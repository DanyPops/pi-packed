/**
 * registry.ts — driven adapter: npm registry over HTTP (web-standard fetch).
 * Lean mapping = Facade over npm's verbose package documents.
 */
import type { Pkg, PkgInfo, Registry, SearchPage } from "./ports.ts";

export class HttpRegistry implements Registry {
	constructor(
		private base = "https://registry.npmjs.org",
		private pageSize = 250,
	) {}

	async search(query: string, limit: number): Promise<SearchPage> {
		return this.searchPage(query, 0, limit);
	}

	async searchPage(query: string, from: number, size: number): Promise<SearchPage> {
		const params = new URLSearchParams({ text: query, size: String(size), from: String(from) });
		const res = await fetch(`${this.base}/-/v1/search?${params}`);
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
		const out: Pkg[] = [];
		let from = 0;
		for (;;) {
			const { results, total } = await this.searchPage(query, from, this.pageSize);
			out.push(...results);
			from += results.length;
			if (results.length === 0 || from >= total) return out;
		}
	}

	async info(name: string): Promise<PkgInfo> {
		const res = await fetch(`${this.base}/${encodeURIComponent(name).replace("%2F", "/")}`, {
			headers: { accept: "application/vnd.npm.install-v1+json" },
		});
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
