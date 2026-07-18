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
import { openDb, latestVersion, dbPath } from "./db.ts";
import {
	DAEMON_HOST, ENV, WATCH_INTERVAL_DEFAULT_MS, CATALOG_INTERVAL_DEFAULT_MS,
	IDLE_BUDGET_DEFAULT_MS, WATCHDOG_TICK_MS,
} from "./constants.ts";
import { readInstalledPackages, defaultPiHome } from "./installed.ts";

export function serveMain(): void {
	const dir = stateDir();
	const token = loadOrCreateToken(dir);
	const reg = new HttpRegistry();
	const app = createApp({ reg, inst: new ExecInstaller(), token, stateDir: dir });

	let lastActive = Date.now();
	const server = Bun.serve({
		port: 0,
		hostname: DAEMON_HOST,
		fetch: (req) => {
			lastActive = Date.now();
			return app.fetch(req);
		},
	});
	if (!server.port) throw new Error("failed to bind listener");
	writePort(dir, server.port);

	// Event producer #1: drift detection from the local mirror (default 30min).
	const watcherDb = openDb(dbPath(dir));
	const stopWatcher = startWatcher((name) => latestVersion(watcherDb, name), dir, () => readInstalledPackages(defaultPiHome()), {
		intervalMs: envMs(ENV.WATCH_SECS, WATCH_INTERVAL_DEFAULT_MS),
	});
	const stopCatalog = startCatalogSync(reg, dir, envMs(ENV.CATALOG_SECS, CATALOG_INTERVAL_DEFAULT_MS));

	// Idle watchdog: for on-demand spawns. PI_PACKED_IDLE_SECS=0 disables it
	// (systemd or another supervisor owns the lifecycle then).
	const idleBudget = envMs(ENV.IDLE_SECS, IDLE_BUDGET_DEFAULT_MS);
	let watchdog: ReturnType<typeof setInterval> | undefined;
	if (idleBudget > 0) {
		watchdog = setInterval(() => {
			if (idleExpired(lastActive, Date.now(), idleBudget)) {
				console.error(`[packed] idle for ${idleBudget / 1000}s, exiting`);
				shutdown();
			}
		}, WATCHDOG_TICK_MS);
	}

	function shutdown(): void {
		if (watchdog) clearInterval(watchdog);
		stopWatcher();
		stopCatalog();
		watcherDb.close();
		server.stop(true);
		process.exit(0);
	}
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	console.error(
		`[packed] listening on ${DAEMON_HOST}:${server.port} (state ${dir}, watch ${envMs(ENV.WATCH_SECS, WATCH_INTERVAL_DEFAULT_MS) / 1000}s, idle ${idleBudget / 1000}s)`,
	);
}
