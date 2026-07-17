/**
 * catalog.ts — event producer #2: bulk snapshot of every pi package.
 * npm's search API has no ETag/conditional requests (CDN max-age only),
 * so freshness is TTL-based: resync on serve start + interval.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pkg, Registry } from "./ports.ts";

export interface CatalogSnapshot {
	fetchedAt: string;
	packages: Pkg[];
}

function catalogPath(dir: string): string {
	return join(dir, "catalog.json");
}

export async function saveCatalog(dir: string, snap: CatalogSnapshot): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(catalogPath(dir), JSON.stringify(snap), { mode: 0o600 });
}

export async function loadCatalog(dir: string): Promise<CatalogSnapshot | undefined> {
	try {
		return JSON.parse(await readFile(catalogPath(dir), "utf8")) as CatalogSnapshot;
	} catch {
		return undefined;
	}
}

export function catalogStale(snap: CatalogSnapshot | undefined, ttlMs: number): boolean {
	if (!snap?.fetchedAt) return true;
	return Date.now() - Date.parse(snap.fetchedAt) > ttlMs;
}

/** Full sync: paginate the whole keyword universe into a lean snapshot. */
export async function syncCatalog(reg: Registry, dir: string, query = "keywords:pi-package"): Promise<number> {
	const packages = await reg.searchAll(query);
	await saveCatalog(dir, { fetchedAt: new Date().toISOString(), packages });
	return packages.length;
}

export function startCatalogSync(
	reg: Registry,
	dir: string,
	ttlMs: number,
	onError?: (e: unknown) => void,
): () => void {
	async function sync(): Promise<void> {
		try {
			if (catalogStale(await loadCatalog(dir), ttlMs)) {
				const n = await syncCatalog(reg, dir);
				console.error(`[packed] catalog synced: ${n} packages`);
			}
		} catch (e) {
			onError?.(e);
		}
	}
	void sync();
	const timer = setInterval(() => void sync(), ttlMs);
	return () => clearInterval(timer);
}
