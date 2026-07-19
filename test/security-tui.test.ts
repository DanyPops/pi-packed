import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPackedSettings } from "../extension/src/security-tui.ts";
import type { Natives } from "../extension/src/packed.ts";

describe("/packed security settings", () => {
	it("writes an explicit never approval choice", async () => {
		let value: "always" | "never" = "always";
		const notices: string[] = [];
		const natives = {
			async security() { return { installApproval: value }; },
			async setInstallApproval(next: "always" | "never") { value = next; return { installApproval: value }; },
		} as Natives;
		const ctx = {
			hasUI: true,
			ui: {
				async select() { return "Never require approval (unsafe opt-out)"; },
				notify(message: string) { notices.push(message); },
			},
		} as unknown as ExtensionCommandContext;

		await showPackedSettings(ctx, natives);

		expect(String(value)).toBe("never");
		expect(notices.join("\n")).toContain("confirmation disabled");
	});
});
