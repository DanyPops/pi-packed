/**
 * cli.ts — second driving adapter (humans drive the same hexagon ports).
 * cliRun is pure: ({code, out}) in, no I/O — the entry point prints.
 * Command table follows the go-tool/Cobra convention; flags may appear
 * anywhere (agents put them anywhere).
 */
import { buildSearchQuery, clampLimit } from "./ports.ts";
import type { Installer, Registry } from "./ports.ts";
import { readInstalledPackages } from "./installed.ts";
import { checkUpdates, loadUpdates } from "./watcher.ts";
import { loadCatalog } from "./catalog.ts";
import { NAME_RE } from "./install.ts";

const SOURCE_RE = /^(npm:[A-Za-z0-9@._/-]+|git:[A-Za-z0-9@:._/-]+|https:\/\/[A-Za-z0-9@:._/?=&%~-]+)$/;

const USAGE = `packed — package service for the Pi agent

usage:
  packed search <query> [--limit N] [--json]   search pi packages on npm
  packed info <name> [--json]                  package details
  packed updates [--cached] [--json]           available updates (cached = daemon snapshot)
  packed installed [--json]                    installed pi packages
  packed catalog [--json]                      full pi-package catalog snapshot
  packed install <source>                      pi install npm:|git:|https://…
  packed remove <name>                         remove by bare npm name
  packed serve                                 run the long-running daemon
  packed service                               print a systemd user unit
  packed version                               print version
`;

export interface CliDeps {
	reg: Registry;
	inst: Installer;
	stateDir: string;
	piHome: string;
	execPath?: string; // bun binary (defaults to process.execPath)
	cliPath?: string; // this CLI's entry file (for the systemd unit)
}

export interface CliResult {
	code: number;
	out: string;
}

interface Flags {
	json: boolean;
	limit: number;
	cached: boolean;
}

function parseFlags(rest: string[]): { flags: Flags; pos: string[] } {
	const flags: Flags = { json: false, limit: 10, cached: false };
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") flags.json = true;
		else if (a === "--cached") flags.cached = true;
		else if (a === "--limit" && i + 1 < rest.length) flags.limit = Number(rest[++i]) || 10;
		else if (a.startsWith("--limit=")) flags.limit = Number(a.slice(8)) || 10;
		else pos.push(a);
	}
	return { flags, pos };
}

type Command = (rest: string[], d: CliDeps, flags: Flags, pos: string[]) => Promise<CliResult>;

const ok = (out: string): CliResult => ({ code: 0, out });
const fail = (out: string, code = 1): CliResult => ({ code, out });
const usageErr = (out: string): CliResult => ({ code: 2, out });

const commands: Record<string, { usage: string; run: Command }> = {
	search: {
		usage: "packed search <query> [--limit N] [--json]",
		async run(_rest, d, flags, pos) {
			const q = pos[0];
			if (!q) return usageErr(`usage: ${commands["search"]!.usage}\n`);
			const { results, total } = await d.reg.search(buildSearchQuery(q), clampLimit(flags.limit, 10, 50));
			if (flags.json) return ok(JSON.stringify({ query: q, total, results }) + "\n");
			if (results.length === 0) return ok(`no pi packages found for "${q}"\n`);
			let out = `${total} package(s) (showing ${results.length}):\n\n`;
			for (const p of results) out += `  ${p.name}@${p.version}\n    ${p.description ?? ""}\n`;
			return ok(out);
		},
	},

	info: {
		usage: "packed info <name> [--json]",
		async run(_rest, d, flags, pos) {
			const name = pos[0];
			if (!name) return usageErr(`usage: ${commands["info"]!.usage}\n`);
			const info = await d.reg.info(name);
			if (flags.json) return ok(JSON.stringify(info) + "\n");
			let out = `${info.name}@${info.version}\n${info.description ?? ""}\n`;
			if (info.repository) out += `repo: ${info.repository}\n`;
			if (info.pi) out += `provides: ${Object.keys(info.pi).join(", ")}\n`;
			return ok(out);
		},
	},

	updates: {
		usage: "packed updates [--cached] [--json]",
		async run(_rest, d, flags) {
			let updates;
			if (flags.cached) {
				updates = (await loadUpdates(d.stateDir))?.updates ?? [];
			} else {
				updates = await checkUpdates(d.reg, readInstalledPackages(d.piHome));
			}
			if (flags.json) {
				return ok(JSON.stringify({ checkedAt: new Date().toISOString(), updates }) + "\n");
			}
			if (updates.length === 0) return ok("all pi packages up to date\n");
			let out = `${updates.length} update(s) available:\n\n`;
			for (const u of updates) out += `  ${u.name}  ${u.installed} → ${u.latest}\n`;
			return ok(out + "\nrun: pi update --extensions\n");
		},
	},

	installed: {
		usage: "packed installed [--json]",
		async run(_rest, d, flags) {
			const installed = readInstalledPackages(d.piHome);
			if (flags.json) return ok(JSON.stringify(installed) + "\n");
			return ok(installed.map((p) => `  ${p.name}@${p.pinned ?? p.installed ?? "?"}\n`).join(""));
		},
	},

	catalog: {
		usage: "packed catalog [--json]",
		async run(_rest, d, flags) {
			const snap = await loadCatalog(d.stateDir);
			const packages = snap?.packages ?? [];
			if (flags.json) return ok(JSON.stringify(snap ?? { packages: [] }) + "\n");
			let out = `${packages.length} packages in catalog (fetched ${snap?.fetchedAt ?? "never"})\n\n`;
			for (const p of packages.slice(0, 50)) out += `  ${p.name}@${p.version}\n`;
			return ok(out);
		},
	},

	install: {
		usage: "packed install npm:<pkg>[@ver] | git:<host>/<owner>/<repo>[@ref] | https://…",
		async run(_rest, d, _flags, pos) {
			const source = pos[0] ?? "";
			if (!SOURCE_RE.test(source)) return usageErr(`usage: ${commands["install"]!.usage}\n`);
			try {
				return ok((await d.inst.install(source)) + "\n");
			} catch (e) {
				return fail(`${e instanceof Error ? e.message : e}\n`);
			}
		},
	},

	remove: {
		usage: "packed remove <name>  (bare npm name, e.g. pi-lsp or @scope/pkg)",
		async run(_rest, d, _flags, pos) {
			const name = pos[0] ?? "";
			if (!NAME_RE.test(name)) return usageErr(`usage: ${commands["remove"]!.usage}\n`);
			try {
				return ok((await d.inst.remove(`npm:${name}`)) + "\n");
			} catch (e) {
				return fail(`${e instanceof Error ? e.message : e}\n`);
			}
		},
	},

	service: {
		usage: "packed service  (print a systemd user unit to stdout)",
		async run(_rest, d) {
			const execPath = d.execPath ?? process.execPath;
			const cliPath = d.cliPath ?? new URL("./cli.ts", import.meta.url).pathname;
			return ok(renderUnit(execPath, cliPath));
		},
	},

	version: {
		usage: "packed version",
		async run() {
			return ok("0.1.0\n");
		},
	},
};

/** systemd user unit. Idle self-exit is disabled — systemd owns the
 * lifecycle (Restart=on-failure takes over). */
export function renderUnit(execPath: string, cliPath: string): string {
	return `[Unit]
Description=pi-packed package service (Pi agent)

[Service]
Type=simple
ExecStart=${execPath} ${cliPath} serve
Restart=on-failure
RestartSec=2
Environment=PI_PACKED_IDLE_SECS=0
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export async function cliRun(args: string[], d: CliDeps): Promise<CliResult> {
	const [name, ...rest] = args;
	if (!name) return usageErr(USAGE);
	if (name === "help" || name === "--help" || name === "-h") return { code: 0, out: USAGE };
	const cmd = commands[name];
	if (!cmd) return usageErr(`unknown command "${name}"\n${USAGE}`);
	const { flags, pos } = parseFlags(rest);
	try {
		return await cmd.run(rest, d, flags, pos);
	} catch (e) {
		return fail(`${name} failed: ${e instanceof Error ? e.message : e}\n`);
	}
}

// Entry point (bun src/cli.ts …). `serve` is dispatched before any proxying
// so the daemon always talks directly to npm.
if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "serve") {
		const { serveMain } = await import("./daemon.ts");
		serveMain();
	} else {
		const { stateDir } = await import("./state.ts");
		const { defaultPiHome } = await import("./installed.ts");
		const { resolveRegistry } = await import("./client.ts");
		const { ExecInstaller } = await import("./install.ts");
		const dir = stateDir();
		const reg = await resolveRegistry(dir, "https://registry.npmjs.org");
		const { code, out } = await cliRun(args, {
			reg,
			inst: new ExecInstaller(),
			stateDir: dir,
			piHome: defaultPiHome(),
		});
		process.stdout.write(out);
		process.exit(code);
	}
}
