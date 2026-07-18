/**
 * ports.ts — the hexagon's driven ports and lean domain types.
 * Driving adapters: HTTP service (service.ts), CLI (cli.ts), watcher,
 * tests. Driven adapters: registry.ts (npm), install.ts (pi exec).
 */

export interface Pkg {
	name: string;
	version: string;
	description?: string;
	date?: string;
}

export interface PkgInfo {
	name: string;
	version: string;
	description?: string;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	pi?: Record<string, unknown>;
	modified?: string;
	unpackedSize?: number;
}

export interface SearchPage {
	results: Pkg[];
	total: number;
}

/** Driven port: package metadata source (npm registry, or the daemon proxy). */
export interface Registry {
	search(query: string, limit: number): Promise<SearchPage>;
	searchPage(query: string, from: number, size: number): Promise<SearchPage>;
	searchAll(query: string): Promise<Pkg[]>;
	info(name: string): Promise<PkgInfo>;
}

/** Driven port: pi CLI mutations. */
export interface Installer {
	install(source: string): Promise<string>;
	remove(source: string): Promise<string>;
}

export interface InstalledPkg {
	name: string;
	pinned?: string;
	installed?: string;
}

export interface UpdateEntry {
	name: string;
	installed: string;
	latest: string;
	detectedAt?: string;
}

export interface UpdatesSnapshot {
	checkedAt: string;
	updates: UpdateEntry[];
}

/** Scope every query to pi packages unless the caller already qualified it. */
import { PI_PACKAGE_KEYWORD } from "./constants.ts";

export function buildSearchQuery(q: string): string {
	const t = q.trim();
	if (t.includes("keywords:")) return t;
	return t === "" ? PI_PACKAGE_KEYWORD : `${PI_PACKAGE_KEYWORD} ${t}`;
}

export function clampLimit(v: number, def: number, max: number): number {
	if (!Number.isFinite(v) || v <= 0) return def;
	return Math.min(v, max);
}
