/**
 * daemon.ts — serve mode: thin wiring around tested units. Bun.serve wraps
 * the hexagon's fetch handler; watcher + catalogSync produce snapshots;
 * idle watchdog self-terminates (the daemon is spawned on demand).
 */
import { createApp } from "./service.ts";
import { HttpRegistry } from "./registry.ts";
import { ExecInstaller } from "./install.ts";
import { loadOrCreateToken, writePort, idleExpired, envMs, stateDir } from "./state.ts";
import { startWatcher } from "./watcher.ts";
import { startCatalogSync } from "./catalog.ts";
import { readInstalledPackages, defaultPiHome } from "./installed.ts";

export function serveMain(): void {
	const dir = stateDir();
	const token = loadOrCreateToken(dir);
	const reg = new HttpRegistry();
	const app = createApp({ reg, inst: new ExecInstaller(), token, stateDir: dir });

	let lastActive = Date.now();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			lastActive = Date.now();
			return app.fetch(req);
		},
	});
	if (!server.port) throw new Error("failed to bind listener");
	writePort(dir, server.port);

	const stopWatcher = startWatcher(reg, dir, () => readInstalledPackages(defaultPiHome()), {
		intervalMs: envMs("PI_PACKED_WATCH_SECS", 30 * 60_000),
	});
	const stopCatalog = startCatalogSync(reg, dir, envMs("PI_PACKED_CATALOG_SECS", 6 * 3_600_000));

	// Idle watchdog: for on-demand spawns. PI_PACKED_IDLE_SECS=0 disables it
	// (systemd or another supervisor owns the lifecycle then).
	const idleBudget = envMs("PI_PACKED_IDLE_SECS", 10 * 60_000);
	let watchdog: ReturnType<typeof setInterval> | undefined;
	if (idleBudget > 0) {
		watchdog = setInterval(() => {
			if (idleExpired(lastActive, Date.now(), idleBudget)) {
				console.error(`[packed] idle for ${idleBudget / 1000}s, exiting`);
				shutdown();
			}
		}, 15_000);
	}

	function shutdown(): void {
		if (watchdog) clearInterval(watchdog);
		stopWatcher();
		stopCatalog();
		server.stop(true);
		process.exit(0);
	}
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	console.error(
		`[packed] listening on 127.0.0.1:${server.port} (state ${dir}, watch ${envMs("PI_PACKED_WATCH_SECS", 30 * 60_000) / 1000}s, idle ${idleBudget / 1000}s)`,
	);
}
