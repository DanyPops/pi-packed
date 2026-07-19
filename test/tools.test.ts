import { describe, expect, it } from "bun:test";
import { installPackageWithPolicy } from "../extension/src/tools.ts";

describe("pkg_install approval policy", () => {
	it("requires confirmation under the secure default", async () => {
		let installs = 0;
		let confirms = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { installApproval: "always" }; },
			async install() { installs += 1; return "installed"; },
		}, {
			hasUI: true,
			ui: { async confirm() { confirms += 1; return false; } },
		});
		expect(confirms).toBe(1);
		expect(installs).toBe(0);
		expect(result.content[0]?.text).toContain("cancelled");
	});

	it("allows explicit never policy without UI", async () => {
		let installs = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { installApproval: "never" }; },
			async install() { installs += 1; return "installed"; },
		}, {
			hasUI: false,
			ui: { async confirm() { throw new Error("must not prompt"); } },
		});
		expect(installs).toBe(1);
		expect(result.content[0]?.text).toBe("installed");
	});
});
