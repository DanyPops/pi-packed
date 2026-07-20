/**
 * client.ts — authenticated loopback clients for the supervised package daemon.
 * The CLI may fall back to npm for read-only registry queries; Pi extensions use
 * PackageDaemonClient exclusively so Bun execution and SQLite remain daemon-owned.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledPkg, Installer, PkgInfo, Registry, SearchPage, UpdateEntry, UpdatesSnapshot } from "./ports.ts";
import { HttpRegistry } from "./registry.ts";
import { DAEMON_HOST, PROBE_TIMEOUT_MS, REGISTRY_FETCH_TIMEOUT_MS, PORT_FILE, TOKEN_FILE } from "./constants.ts";
import type { MutationApproval, SecuritySettings } from "./security.ts";

export type FetchTransport = (request: Request) => Promise<Response>;

export interface PackageDaemonPort {
	search(query: string, limit: number, offline?: boolean): Promise<{ query: string; total: number; results: SearchPage["results"] }>;
	info(name: string): Promise<PkgInfo>;
	installed(): Promise<InstalledPkg[]>;
	updates(): Promise<UpdateEntry[]>;
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: MutationApproval, approved?: boolean): Promise<SecuritySettings>;
	install(source: string, approved?: boolean): Promise<string>;
	remove(name: string, approved?: boolean): Promise<string>;
}

interface MutationResponse {
	ok: boolean;
	output: string;
}

export class PackageDaemonError extends Error {
	constructor(
		message: string,
		readonly operation: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "PackageDaemonError";
	}
}

export class PackageDaemonClient implements PackageDaemonPort {
	constructor(
		private readonly base: string,
		private readonly token: string,
		private readonly transport: FetchTransport = fetch,
	) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${this.token}`);
		if (init.body !== undefined) headers.set("content-type", "application/json");
		const response = await this.transport(new Request(`${this.base}${path}`, {
			...init,
			headers,
			signal: init.signal ?? AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
		}));
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new PackageDaemonError(`package daemon returned invalid JSON (HTTP ${response.status})`, path, response.status);
		}
		if (!response.ok) {
			const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
				? (body as { error: string }).error
				: `package daemon HTTP ${response.status}`;
			throw new PackageDaemonError(message, path, response.status);
		}
		return body as T;
	}

	async search(query: string, limit: number, offline = false): Promise<{ query: string; total: number; results: SearchPage["results"] }> {
		const params = new URLSearchParams({ q: query, limit: String(limit) });
		if (offline) params.set("offline", "1");
		return this.request(`/search?${params}`);
	}

	info(name: string): Promise<PkgInfo> {
		return this.request(`/info?name=${encodeURIComponent(name)}`);
	}

	installed(): Promise<InstalledPkg[]> {
		return this.request("/installed");
	}

	async updates(): Promise<UpdateEntry[]> {
		return (await this.request<UpdatesSnapshot>("/updates")).updates;
	}

	security(): Promise<SecuritySettings> {
		return this.request("/security");
	}

	setMutationApproval(mutationApproval: MutationApproval, approved = false): Promise<SecuritySettings> {
		return this.request("/security", { method: "POST", body: JSON.stringify({ mutationApproval, approved }) });
	}

	async install(source: string, approved = false): Promise<string> {
		const result = await this.request<MutationResponse>("/install", {
			method: "POST",
			body: JSON.stringify({ source, approved }),
		});
		if (!result.ok) throw new PackageDaemonError(result.output || `failed to install ${source}`, "install");
		return result.output;
	}

	async remove(name: string, approved = false): Promise<string> {
		const result = await this.request<MutationResponse>("/remove", {
			method: "POST",
			body: JSON.stringify({ name, approved }),
		});
		if (!result.ok) throw new PackageDaemonError(result.output || `failed to remove ${name}`, "remove");
		return result.output;
	}
}

export class PackageDaemonInstaller implements Installer {
	constructor(private readonly client: PackageDaemonClient) {}

	install(source: string, options?: { approved?: boolean }): Promise<string> {
		return this.client.install(source, options?.approved);
	}

	remove(source: string, options?: { approved?: boolean }): Promise<string> {
		if (!source.startsWith("npm:") || source.length <= 4) {
			throw new PackageDaemonError("daemon package removal requires an npm: source", "remove");
		}
		return this.client.remove(source.slice(4), options?.approved);
	}
}

export class DaemonBackedSecurity {
	constructor(private readonly stateDirectory: string) {}
	async security(): Promise<SecuritySettings> {
		return (await connectPackageDaemon(this.stateDirectory)).security();
	}
	async setMutationApproval(value: MutationApproval, options?: { approved?: boolean }): Promise<SecuritySettings> {
		return (await connectPackageDaemon(this.stateDirectory)).setMutationApproval(value, options?.approved);
	}
}

export class DaemonBackedInstaller implements Installer {
	constructor(private readonly stateDirectory: string) {}

	async install(source: string, options?: { approved?: boolean }): Promise<string> {
		return (await connectPackageDaemon(this.stateDirectory)).install(source, options?.approved);
	}

	async remove(source: string, options?: { approved?: boolean }): Promise<string> {
		return new PackageDaemonInstaller(await connectPackageDaemon(this.stateDirectory)).remove(source, options);
	}
}

export class DaemonRegistry implements Registry {
	private readonly client: PackageDaemonClient;

	constructor(base: string, token: string, transport: FetchTransport = fetch) {
		this.client = new PackageDaemonClient(base, token, transport);
	}

	async search(query: string, limit: number): Promise<SearchPage> {
		const body = await this.client.search(query, limit);
		return { results: body.results, total: body.total };
	}

	async searchPage(query: string, _from: number, size: number): Promise<SearchPage> {
		return this.search(query, size).catch(() => ({ results: [], total: 0 }));
	}

	async searchAll(): Promise<never> {
		throw new Error("searchAll is not supported via the daemon proxy");
	}

	info(name: string): Promise<PkgInfo> {
		return this.client.info(name);
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
		port = readFileSync(join(dir, PORT_FILE), "utf8").trim();
		token = readFileSync(join(dir, TOKEN_FILE), "utf8").trim();
	} catch {
		return undefined;
	}
	const base = `http://${DAEMON_HOST}:${port}`;
	try {
		const res = await fetch(`${base}/health`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (res.ok) return { base, token };
	} catch {
		/* dead daemon or stale files */
	}
	return undefined;
}

export async function connectPackageDaemon(dir: string): Promise<PackageDaemonClient> {
	const handle = await probe(dir);
	if (!handle) throw new Error("pi-packed daemon is unavailable; start packed.service");
	return new PackageDaemonClient(handle.base, handle.token);
}

export async function resolveRegistry(dir: string, npmBase: string): Promise<Registry> {
	const handle = await probe(dir);
	if (handle) return new DaemonRegistry(handle.base, handle.token);
	return new HttpRegistry(npmBase);
}
