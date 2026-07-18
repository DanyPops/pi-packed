/** Daemon state: config dir, bearer token, port file, idle predicate. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV, TOKEN_FILE, PORT_FILE } from "./constants.ts";
import { randomBytes } from "node:crypto";

export function stateDir(): string {
	const envHome = process.env[ENV.HOME];
	if (envHome) return envHome;
	try {
		return join(homedir(), ".cache", "pi-packed");
	} catch {
		return join(tmpdir(), "pi-packed");
	}
}

export function loadOrCreateToken(dir: string): string {
	const path = join(dir, TOKEN_FILE);
	try {
		const tok = readFileSync(path, "utf8").trim();
		if (tok) return tok;
	} catch {
		/* first run */
	}
	const tok = randomBytes(16).toString("hex");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, tok + "\n", { mode: 0o600 });
	return tok;
}

export function writePort(dir: string, port: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, PORT_FILE), String(port) + "\n", { mode: 0o600 });
}

export function idleExpired(lastActiveMs: number, nowMs: number, budgetMs: number): boolean {
	return nowMs - lastActiveMs > budgetMs;
}

/** Env knob in seconds → ms. Zero means "disabled" (external lifecycle
 * manager such as systemd owns the process). Garbage → default. */
export function envMs(key: string, defMs: number): number {
	const raw = process.env[key];
	if (raw === undefined) return defMs;
	const v = Number(raw);
	if (!Number.isFinite(v) || v < 0) return defMs;
	if (v === 0) return 0;
	return v * 1000;
}
