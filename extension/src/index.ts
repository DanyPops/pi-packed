/**
 * pi-packed — Pi extension seam.
 *
 * Thin by design: registers agent tools (pkg_search/pkg_info/pkg_install),
 * the /packages command, and a session_start update notification. ALL logic
 * lives in the Bun service (src/): registry access, caching, watcher,
 * catalog sync, install execution.
 *
 * Install: pi install git:github.com/DanyPops/pi-packed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.js";
import { showPackages } from "./tui.js";
import { runPacked } from "./packed.js";
import { formatUpdateNotice } from "./model.js";
import type { UpdatesSnapshot } from "./packed.js";

export default function (pi: ExtensionAPI) {
	registerTools(pi);

	pi.registerCommand("packages", {
		description: "Browse and manage installed Pi packages (pi-packed)",
		handler: async (_args, ctx) => {
			await showPackages(ctx);
		},
	});

	// The watcher (daemon side) produces the snapshot; the seam consumes it
	// on Pi's own lifecycle event — that's the whole event-driven story.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const snap = await runPacked<UpdatesSnapshot>(["updates", "--cached"], 3_000);
			if (snap.updates?.length) {
				ctx.ui.notify(`${formatUpdateNotice(snap.updates)} — /packages to review`, "info");
			}
		} catch {
			// packed missing or daemon down — stay silent, never block startup.
		}
	});
}
