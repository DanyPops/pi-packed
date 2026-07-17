/** installed.ts — pi's settings.json is the source of truth for what is
 * installed; node_modules supplies versions for unpinned sources. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstalledPkg } from "./ports.ts";

export function splitNpmSource(spec: string): [name: string, version: string] {
	const i = spec.lastIndexOf("@");
	if (i <= 0) return [spec, ""];
	return [spec.slice(0, i), spec.slice(i + 1)];
}

function extractSource(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		const s = (entry as Record<string, unknown>)["source"];
		if (typeof s === "string") return s;
	}
	return "";
}

function nodeModulesVersion(piHome: string, name: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(piHome, "npm", "node_modules", name, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

export function readInstalledPackages(piHome: string): InstalledPkg[] {
	let settings: { packages?: unknown[] };
	try {
		settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
	} catch {
		return [];
	}
	const out: InstalledPkg[] = [];
	for (const raw of settings.packages ?? []) {
		const source = extractSource(raw);
		if (!source.startsWith("npm:")) continue;
		const [name, pinned] = splitNpmSource(source.slice(4));
		out.push({
			name,
			pinned: pinned || undefined,
			installed: pinned ? undefined : nodeModulesVersion(piHome, name),
		});
	}
	return out;
}

export function defaultPiHome(): string {
	if (process.env["PI_PACKED_PI_HOME"]) return process.env["PI_PACKED_PI_HOME"];
	return join(homedir(), ".pi", "agent");
}
