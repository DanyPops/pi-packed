import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { InstallApproval } from "../../src/security.ts";
import type { Natives } from "./packed.ts";

const OPTIONS: Array<{ value: InstallApproval; label: string }> = [
	{ value: "always", label: "Always require approval (recommended)" },
	{ value: "never", label: "Never require approval (unsafe opt-out)" },
];

export async function showPackedSettings(ctx: ExtensionCommandContext, natives: Natives): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed requires interactive mode", "warning");
		return;
	}
	try {
		const current = await natives.security();
		const choice = await ctx.ui.select(
			`Package install approval · current: ${current.installApproval}`,
			[...OPTIONS.map(({ label }) => label), "Cancel"],
		);
		const selected = OPTIONS.find(({ label }) => label === choice);
		if (!selected || selected.value === current.installApproval) return;
		const updated = await natives.setInstallApproval(selected.value);
		ctx.ui.notify(
			updated.installApproval === "always"
				? "Package installs now require confirmation."
				: "Package install confirmation disabled. Packages can execute arbitrary code.",
			updated.installApproval === "always" ? "info" : "warning",
		);
	} catch (error) {
		ctx.ui.notify(`packed security settings failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}
