/** Agent-facing package tools over the authenticated daemon. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { packagePermissionDecision, type PackageOperation } from "../../src/security.ts";
import type { Natives } from "./packed.js";

function text(t: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

type ApprovalContext = {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
};

export async function approvePackageOperation(
	operation: PackageOperation,
	command: string,
	natives: Pick<Natives, "security">,
	ctx: ApprovalContext,
): Promise<{ allowed: boolean; approved: boolean; message?: string }> {
	const settings = await natives.security();
	const decision = packagePermissionDecision(settings, operation);
	if (!decision.approvalRequired) return { allowed: true, approved: false };
	if (!ctx.hasUI) {
		return {
			allowed: false,
			approved: false,
			message: `${operation} requires interactive approval; change mutationApproval in /packed only to deliberately opt out.`,
		};
	}
	const approved = await ctx.ui.confirm(
		`${operation[0]!.toUpperCase()}${operation.slice(1)} Pi package`,
		`Run: ${command}\n\nThis operation can execute package code or mutate Pi settings/install roots. Continue?`,
	);
	return approved ? { allowed: true, approved: true } : { allowed: false, approved: false, message: `${operation} cancelled by user.` };
}

export async function installPackageWithPolicy(
	source: string,
	natives: Pick<Natives, "security" | "install">,
	ctx: ApprovalContext,
) {
	try {
		const approval = await approvePackageOperation("install", `pi install ${source}`, natives, ctx);
		if (!approval.allowed) return text(approval.message ?? "install denied");
		const out = await natives.install(source, approval.approved);
		return text(out || `Installed ${source}. Reload with /reload to activate.`);
	} catch (error) {
		return text(`install failed: ${error instanceof Error ? error.message : error}`);
	}
}

export async function removePackageWithPolicy(
	name: string,
	natives: Pick<Natives, "security" | "remove">,
	ctx: ApprovalContext,
) {
	try {
		const approval = await approvePackageOperation("remove", `pi remove npm:${name}`, natives, ctx);
		if (!approval.allowed) return text(approval.message ?? "remove denied");
		const out = await natives.remove(name, approval.approved);
		return text(out || `Removed ${name}. Reload with /reload to deactivate.`);
	} catch (error) {
		return text(`remove failed: ${error instanceof Error ? error.message : error}`);
	}
}

export function registerTools(pi: ExtensionAPI, natives: Natives): void {
	pi.registerTool({
		name: "pkg_search",
		label: "Pi Package Search",
		description: "Search Pi packages on npm. Bounded read operation; defaults to 10 results and caps at 50.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms, e.g. 'lsp' or 'telegram'" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
		}),
		async execute(_id, params) {
			try {
				const r = await natives.search(params.query, params.limit ?? 10);
				if (r.results.length === 0) return text(`No Pi packages found for "${params.query}".`);
				const lines = r.results.map((p, i) => `${i + 1}. ${p.name}@${p.version}\n   ${p.description ?? ""}`);
				return text(`Found ${r.total} pi package(s) (showing ${r.results.length}):\n\n${lines.join("\n")}`, { results: r.results, total: r.total });
			} catch (error) {
				return text(`pkg_search failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_info",
		label: "Pi Package Info",
		description: "Show bounded metadata and declared Pi resources for one package.",
		parameters: Type.Object({ name: Type.String({ description: "npm package name" }) }),
		async execute(_id, params) {
			try {
				const info = await natives.info(params.name);
				const lines = [
					`${info.name}@${info.version}`,
					info.description ?? "",
					info.repository ? `repo: ${info.repository}` : "",
					info.license ? `license: ${info.license}` : "",
					info.pi ? `provides: ${Object.keys(info.pi).join(", ")}` : "",
					info.unpackedSize ? `size: ${(info.unpackedSize / 1024).toFixed(0)} KB` : "",
					info.modified ? `modified: ${info.modified}` : "",
				].filter(Boolean);
				return text(lines.join("\n"), { info });
			} catch (error) {
				return text(`pkg_info failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_install",
		label: "Pi Package Install",
		description: "Install a Pi package through the authenticated daemon. Operation-aware approval is secure by default.",
		parameters: Type.Object({ source: Type.String({ description: "npm:, git:, or https source" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return installPackageWithPolicy(params.source, natives, ctx);
		},
	});

	pi.registerTool({
		name: "pkg_remove",
		label: "Pi Package Remove",
		description: "Remove an installed npm Pi package through the authenticated daemon. Operation-aware approval is secure by default.",
		parameters: Type.Object({ name: Type.String({ description: "bare npm name, e.g. pi-lsp or @scope/pkg" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return removePackageWithPolicy(params.name, natives, ctx);
		},
	});
}
