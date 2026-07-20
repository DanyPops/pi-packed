import { describe, expect, it } from "bun:test";
import { installPackageWithPolicy, removePackageWithPolicy } from "../extension/src/tools.ts";

describe("native package mutation permission policy", () => {
	it("requires confirmation for install under the secure default", async () => {
		let installs = 0;
		let confirms = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "always" }; },
			async install(_source, approved) { expect(approved).toBe(true); installs += 1; return "installed"; },
		}, {
			hasUI: true,
			ui: { async confirm() { confirms += 1; return false; } },
		});
		expect(confirms).toBe(1);
		expect(installs).toBe(0);
		expect(result.content[0]?.text).toContain("cancelled");
	});

	it("requires the same confirmation for remove", async () => {
		let removes = 0;
		const result = await removePackageWithPolicy("pkg", {
			async security() { return { mutationApproval: "always" }; },
			async remove(_name, approved) { expect(approved).toBe(true); removes += 1; return "removed"; },
		}, {
			hasUI: true,
			ui: { async confirm(_title, message) { expect(message).toContain("pi remove npm:pkg"); return true; } },
		});
		expect(removes).toBe(1);
		expect(result.content[0]?.text).toBe("removed");
	});

	it("allows the explicit never policy without UI for every guarded operation", async () => {
		let installs = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "never" }; },
			async install(_source, approved) { expect(approved).toBe(false); installs += 1; return "installed"; },
		}, {
			hasUI: false,
			ui: { async confirm() { throw new Error("must not prompt"); } },
		});
		expect(installs).toBe(1);
		expect(result.content[0]?.text).toBe("installed");
	});
});
