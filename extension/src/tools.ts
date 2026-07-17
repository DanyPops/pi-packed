/**
 * tools.ts — agent-facing tools. Thin by design: descriptions teach the
 * agent the packed CLI surface; logic lives in the Bun service.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runPacked, runPackedText } from "./packed.js";
import type { PackageInfo, SearchResponse } from "./packed.js";

function text(t: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

export function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pkg_search",
		label: "Pi Package Search",
		description:
			"Search Pi packages (extensions, skills, themes, prompts) on the npm registry. " +
			"Scoped to the pi-package keyword automatically. Returns name, version, description.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms, e.g. 'lsp' or 'telegram'" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const r = await runPacked<SearchResponse>(
					["search", params.query, "--limit", String(params.limit ?? 10)],
				);
				if (r.results.length === 0) return text(`No Pi packages found for "${params.query}".`);
				const lines = r.results.map(
					(p, i) => `${i + 1}. ${p.name}@${p.version}\n   ${p.description ?? ""}`,
				);
				return text(
					`Found ${r.total} pi package(s) (showing ${r.results.length}):\n\n${lines.join("\n")}`,
					{ results: r.results, total: r.total },
				);
			} catch (e) {
				return text(`pkg_search failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_info",
		label: "Pi Package Info",
		description:
			"Show details for a Pi package: latest version, description, repository, " +
			"declared pi resources (extensions/skills/themes/prompts), size, license.",
		parameters: Type.Object({
			name: Type.String({ description: "npm package name, e.g. 'pi-lsp' or '@scope/pkg'" }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const info = await runPacked<PackageInfo>(["info", params.name]);
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
			} catch (e) {
				return text(`pkg_info failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_install",
		label: "Pi Package Install",
		description:
			"Install a Pi package (pi install). Supports npm:<pkg>[@ver], git:<host>/<owner>/<repo>[@ref], " +
			"or https:// URLs. Packages execute arbitrary code — the user confirms every install.",
		parameters: Type.Object({
			source: Type.String({ description: "e.g. 'npm:pi-lsp', 'npm:@scope/pkg@1.2.3', 'git:github.com/u/r@v1'" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return text("pkg_install requires an interactive session (the user must confirm).");
			}
			const ok = await ctx.ui.confirm(
				"Install Pi package",
				`Run: pi install ${params.source}\n\nPackages execute arbitrary code. Continue?`,
			);
			if (!ok) return text("Install cancelled by user.");
			try {
				const out = await runPackedText(["install", params.source]);
				return text(out || `Installed ${params.source}. Reload with /reload to activate.`);
			} catch (e) {
				return text(`install failed: ${e instanceof Error ? e.message : e}`);
			}
		},
	});
}
