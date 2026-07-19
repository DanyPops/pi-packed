import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECURITY_FILE } from "./constants.ts";

export const INSTALL_APPROVAL_VALUES = ["always", "never"] as const;
export type InstallApproval = typeof INSTALL_APPROVAL_VALUES[number];
export interface SecuritySettings { installApproval: InstallApproval }
export interface SecuritySettingsPort {
	security(): Promise<SecuritySettings>;
	setInstallApproval(value: InstallApproval): Promise<SecuritySettings>;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { installApproval: "always" };

export function readSecuritySettings(stateDir: string): SecuritySettings {
	try {
		const value = JSON.parse(readFileSync(join(stateDir, SECURITY_FILE), "utf8")) as { installApproval?: unknown };
		return INSTALL_APPROVAL_VALUES.includes(value.installApproval as InstallApproval)
			? { installApproval: value.installApproval as InstallApproval }
			: { ...DEFAULT_SECURITY_SETTINGS };
	} catch {
		return { ...DEFAULT_SECURITY_SETTINGS };
	}
}

export function writeSecuritySettings(stateDir: string, settings: SecuritySettings): SecuritySettings {
	if (!INSTALL_APPROVAL_VALUES.includes(settings.installApproval)) throw new Error("installApproval must be always or never");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const target = join(stateDir, SECURITY_FILE);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
	renameSync(temporary, target);
	return { ...settings };
}
