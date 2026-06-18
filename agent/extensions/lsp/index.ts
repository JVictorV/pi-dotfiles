import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadLspConfig } from "./config";
import { findRepositoryRoot, formatPermission } from "./paths";
import { LspPermissionStore } from "./permissions";
import type { LspPermission } from "./types";

const parseServerId = (args: string): string | undefined => {
	const serverId = args.trim();
	return serverId.length > 0 ? serverId : undefined;
};

const permissionSummary = async (cwd: string): Promise<string> => {
	const repoRoot = await findRepositoryRoot(cwd);
	const store = await LspPermissionStore.load();
	const entries = store.entries(repoRoot);
	if (entries.length === 0) {
		return `LSP permissions for ${repoRoot}:\n(no stored preferences)`;
	}

	const lines = entries.map(
		([serverId, permission]) => `- ${serverId}: ${formatPermission(permission)}`,
	);
	return `LSP permissions for ${repoRoot}:\n${lines.join("\n")}`;
};

const setPermission = async (
	cwd: string,
	serverId: string,
	permission: LspPermission,
): Promise<string> => {
	const repoRoot = await findRepositoryRoot(cwd);
	const store = await LspPermissionStore.load();
	await store.set(repoRoot, serverId, permission);
	return `Set ${serverId} to ${permission} for ${repoRoot}`;
};

const resetPermission = async (cwd: string, args: string): Promise<string> => {
	const repoRoot = await findRepositoryRoot(cwd);
	const serverId = parseServerId(args);
	const store = await LspPermissionStore.load();

	if (serverId === undefined || serverId === "all") {
		await store.reset(repoRoot);
		return `Reset all LSP permissions for ${repoRoot}`;
	}

	await store.reset(repoRoot, serverId);
	return `Reset ${serverId} LSP permission for ${repoRoot}`;
};

export default function lspExtension(pi: ExtensionAPI) {
	pi.registerCommand("lsp-status", {
		description: "Show LSP extension status for the current project",
		handler: async (_args, ctx) => {
			const repoRoot = await findRepositoryRoot(ctx.cwd);
			const config = await loadLspConfig();
			const configuredServers = Object.keys(config.servers).sort();
			const configLine =
				configuredServers.length === 0
					? "No custom servers configured in agent/lsp.json."
					: `Configured custom/override servers: ${configuredServers.join(", ")}`;
			ctx.ui.notify(`LSP status for ${repoRoot}:\nRuntime not started yet.\n${configLine}`, "info");
		},
	});

	pi.registerCommand("lsp-permissions", {
		description: "Show stored LSP spawn permissions for the current repository",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await permissionSummary(ctx.cwd), "info");
		},
	});

	pi.registerCommand("lsp-allow", {
		description: "Allow an LSP server for this repository: /lsp-allow <server>",
		handler: async (args, ctx) => {
			const serverId = parseServerId(args);
			if (serverId === undefined) {
				ctx.ui.notify("Usage: /lsp-allow <server>", "warning");
				return;
			}
			ctx.ui.notify(await setPermission(ctx.cwd, serverId, "allow"), "info");
		},
	});

	pi.registerCommand("lsp-deny", {
		description: "Deny an LSP server for this repository: /lsp-deny <server>",
		handler: async (args, ctx) => {
			const serverId = parseServerId(args);
			if (serverId === undefined) {
				ctx.ui.notify("Usage: /lsp-deny <server>", "warning");
				return;
			}
			ctx.ui.notify(await setPermission(ctx.cwd, serverId, "deny"), "info");
		},
	});

	pi.registerCommand("lsp-reset", {
		description: "Reset LSP permission for this repository: /lsp-reset <server|all>",
		handler: async (args, ctx) => {
			ctx.ui.notify(await resetPermission(ctx.cwd, args), "info");
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart LSP clients: /lsp-restart <server|all>",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"LSP runtime restart will be available after the runtime implementation lands.",
				"info",
			);
		},
	});
}
