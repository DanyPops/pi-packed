/** install.ts — driven adapter: pi CLI mutations via Bun.spawn. */
import type { Installer } from "./ports.ts";

/** Bare npm package name (for `packed remove`). */
export const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

export function defaultPiBin(): string {
	return process.env["PI_PACKED_PI_BIN"] ?? process.env["PI_BIN"] ?? "pi";
}

export class ExecInstaller implements Installer {
	constructor(private bin = defaultPiBin()) {}

	private async run(args: string[]): Promise<string> {
		const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(out || `exit ${code}`);
		return out;
	}

	install(source: string): Promise<string> {
		return this.run(["install", source]);
	}

	remove(source: string): Promise<string> {
		return this.run(["remove", source]);
	}
}
