import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecuritySettings, writeSecuritySettings } from "../src/security.ts";

describe("package security settings", () => {
	it("defaults to always requiring install approval", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-security-"));
		expect(readSecuritySettings(dir)).toEqual({ installApproval: "always" });
	});

	it("persists an explicit unsafe opt-out", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-security-"));
		expect(writeSecuritySettings(dir, { installApproval: "never" })).toEqual({ installApproval: "never" });
		expect(readSecuritySettings(dir)).toEqual({ installApproval: "never" });
	});
});
