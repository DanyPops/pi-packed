/**
 * watcher.ts — event producer #1: version-drift detection.
 * Diffs installed packages against registry dist-tags.latest and persists
 * an event snapshot (event-carried state) for cheap consumer reads.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledPkg, Registry, UpdateEntry, UpdatesSnapshot } from "./ports.ts";

function updatesPath(dir: string): string {
	return join(dir, "updates.json");
}

export async function saveUpdates(dir: string, snap: UpdatesSnapshot): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(updatesPath(dir), JSON.stringify(snap), { mode: 0o600 });
}

export async function loadUpdates(dir: string): Promise<UpdatesSnapshot | undefined> {
	try {
		return JSON.parse(await readFile(updatesPath(dir), "utf8")) as UpdatesSnapshot;
	} catch {
		return undefined;
	}
}

/** Pure diff: drift = latest ≠ what we have (registry latest is authoritative). */
export async function checkUpdates(reg: Registry, installed: InstalledPkg[]): Promise<UpdateEntry[]> {
	const now = new Date().toISOString();
	const updates: UpdateEntry[] = [];
	for (const p of installed) {
		const have = p.installed || p.pinned;
		if (!have) continue;
		try {
			const info = await reg.info(p.name);
			if (info.version && info.version !== have) {
				updates.push({ name: p.name, installed: have, latest: info.version, detectedAt: now });
			}
		} catch (e) {
			console.error(`updates: ${p.name}: ${e instanceof Error ? e.message : e}`);
		}
	}
	return updates;
}

export interface WatcherOptions {
	intervalMs: number;
	onError?: (e: unknown) => void;
}

/** Producer loop: immediate check, then on a timer. Returns a stop function. */
export function startWatcher(
	reg: Registry,
	stateDir: string,
	readInstalled: () => InstalledPkg[],
	opts: WatcherOptions,
): () => void {
	async function check(): Promise<void> {
		try {
			const updates = await checkUpdates(reg, readInstalled());
			await saveUpdates(stateDir, { checkedAt: new Date().toISOString(), updates });
			if (updates.length > 0) console.error(`[packed] updates available: ${updates.length}`);
		} catch (e) {
			opts.onError?.(e);
		}
	}
	void check();
	const timer = setInterval(() => void check(), opts.intervalMs);
	return () => clearInterval(timer);
}
