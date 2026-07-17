/**
 * packed.ts — the ONLY place the seam touches the service side.
 * Thin exec wrapper: every call is `bun <pi-packed>/src/cli.ts <cmd>`.
 * No registry, daemon, or npm knowledge lives here.
 */
import { execFile } from "node:child_process";

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
	checkedAt?: string;
	updates: UpdateEntry[];
}

export interface SearchResult {
	name: string;
	version: string;
	description?: string;
	date?: string;
}

export interface SearchResponse {
	query: string;
	total: number;
	results: SearchResult[];
}

export interface PackageInfo {
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

/** Path to the pi-packed CLI entry (resolved relative to this file). */
export function cliPath(): string {
	if (process.env["PACKED_CLI"]) return process.env["PACKED_CLI"];
	return new URL("../../src/cli.ts", import.meta.url).pathname;
}

export function packedCmd(): { bin: string; prefix: string[] } {
	if (process.env["PACKED_BIN"]) return { bin: process.env["PACKED_BIN"], prefix: [] };
	return { bin: process.env["PACKED_BUN"] ?? "bun", prefix: [cliPath()] };
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.trim() || err.message));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

export async function runPacked<T>(args: string[], timeoutMs = 15_000): Promise<T> {
	const { bin, prefix } = packedCmd();
	const { stdout } = await exec(bin, [...prefix, ...args, "--json"], timeoutMs);
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new Error(`packed ${args[0]}: invalid JSON: ${stdout.slice(0, 200)}`);
	}
}

/** Text output variant for install/remove (human-readable pi output). */
export async function runPackedText(args: string[], timeoutMs = 180_000): Promise<string> {
	const { bin, prefix } = packedCmd();
	const { stdout, stderr } = await exec(bin, [...prefix, ...args], timeoutMs);
	return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}
