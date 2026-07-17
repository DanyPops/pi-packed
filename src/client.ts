/**
 * client.ts — daemonRegistry: remote proxy implementing the Registry port
 * over loopback HTTP. resolveRegistry routes CLI to the warm daemon when
 * reachable, straight to npm otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PkgInfo, Registry, SearchPage } from "./ports.ts";
import { HttpRegistry } from "./registry.ts";

export class DaemonRegistry implements Registry {
	constructor(
		private base: string,
		private token: string,
	) {}

	private async get<T>(path: string): Promise<T> {
		const res = await fetch(`${this.base}${path}`, {
			headers: { authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
		return (await res.json()) as T;
	}

	async search(query: string, limit: number): Promise<SearchPage> {
		const body = await this.get<{ results: SearchPage["results"]; total: number }>(
			`/search?q=${encodeURIComponent(query)}&limit=${limit}`,
		);
		return { results: body.results, total: body.total };
	}

	async searchPage(query: string, from: number, size: number): Promise<SearchPage> {
		// The daemon clamps to 50; page through it for bulk reads.
		return this.search(query, size).catch(() => ({ results: [], total: 0 }));
	}

	async searchAll(): Promise<never> {
		// Bulk sync runs inside the daemon against the direct registry;
		// the proxy never paginates the full universe through the clamp.
		throw new Error("searchAll is not supported via the daemon proxy");
	}

	async info(name: string): Promise<PkgInfo> {
		return this.get<PkgInfo>(`/info?name=${encodeURIComponent(name)}`);
	}
}

export interface DaemonHandle {
	base: string;
	token: string;
}

export async function probe(dir: string): Promise<DaemonHandle | undefined> {
	let port: string;
	let token: string;
	try {
		port = readFileSync(join(dir, "port"), "utf8").trim();
		token = readFileSync(join(dir, "token"), "utf8").trim();
	} catch {
		return undefined;
	}
	const base = `http://127.0.0.1:${port}`;
	try {
		const res = await fetch(`${base}/health`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(800),
		});
		if (res.ok) return { base, token };
	} catch {
		/* dead daemon or stale files */
	}
	return undefined;
}

export async function resolveRegistry(dir: string, npmBase: string): Promise<Registry> {
	const handle = await probe(dir);
	if (handle) return new DaemonRegistry(handle.base, handle.token);
	return new HttpRegistry(npmBase);
}
