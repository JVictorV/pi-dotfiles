import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { loadLspConfig } from "./config";
import { findRepositoryRoot, formatPermission } from "./paths";
import { LspPermissionStore } from "./permissions";
import { LspRuntime } from "./runtime";
import { registerLspTool } from "./tool";
import type { LspPermission } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pathFromToolInput = (input: unknown): string | undefined => {
	if (!isRecord(input)) return undefined;
	return typeof input.path === "string" ? input.path : undefined;
};

const parseServerId = (args: string): string | undefined => {
	const serverId = args.trim();
	return serverId.length > 0 ? serverId : undefined;
};

const permissionSummary = (cwd: string): Effect.Effect<string, unknown> =>
	Effect.gen(function* () {
		const repoRoot = yield* findRepositoryRoot(cwd);
		const store = yield* LspPermissionStore.load();
		const entries = store.entries(repoRoot);
		if (entries.length === 0) {
			return `LSP permissions for ${repoRoot}:\n(no stored preferences)`;
		}

		const lines = entries.map(
			([serverId, permission]) => `- ${serverId}: ${formatPermission(permission)}`,
		);
		return `LSP permissions for ${repoRoot}:\n${lines.join("\n")}`;
	});

const setPermission = (
	cwd: string,
	serverId: string,
	permission: LspPermission,
): Effect.Effect<string, unknown> =>
	Effect.gen(function* () {
		const repoRoot = yield* findRepositoryRoot(cwd);
		const store = yield* LspPermissionStore.load();
		yield* store.set(repoRoot, serverId, permission);
		return `Set ${serverId} to ${permission} for ${repoRoot}`;
	});

const resetPermission = (cwd: string, args: string): Effect.Effect<string, unknown> =>
	Effect.gen(function* () {
		const repoRoot = yield* findRepositoryRoot(cwd);
		const serverId = parseServerId(args);
		const store = yield* LspPermissionStore.load();

		if (serverId === undefined || serverId === "all") {
			yield* store.reset(repoRoot);
			return `Reset all LSP permissions for ${repoRoot}`;
		}

		yield* store.reset(repoRoot, serverId);
		return `Reset ${serverId} LSP permission for ${repoRoot}`;
	});

const emitStatus = (pi: ExtensionAPI, runtime: LspRuntime | undefined): void => {
	const statuses = runtime?.status() ?? [];
	pi.events.emit("lsp:status", {
		running: statuses
			.filter((status) => status.status === "connected")
			.map((status) => ({ id: status.serverId, label: status.label })),
		broken: statuses
			.filter((status) => status.status === "broken")
			.map((status) => ({ id: status.serverId, label: status.label })),
	});
};

const formatStatus = (runtime: LspRuntime | undefined): string => {
	if (runtime === undefined) return "LSP runtime is not initialized.";
	const statuses = runtime.status();
	const servers = runtime.serverIds();
	const serverLine =
		servers.length === 0 ? "No servers available." : `Available servers: ${servers.join(", ")}`;
	if (statuses.length === 0) {
		return `No LSP clients running.\n${serverLine}`;
	}

	const lines = statuses.map(
		(status) =>
			`- ${status.serverId} (${status.status}) root=${status.displayRoot} label=${status.label}`,
	);
	return `LSP clients:\n${lines.join("\n")}\n${serverLine}`;
};

export default function lspExtension(pi: ExtensionAPI) {
	let runtime: LspRuntime | undefined;

	pi.on("session_start", async (_event, ctx) => {
		runtime = new LspRuntime({
			cwd: ctx.cwd,
			config: await Effect.runPromise(loadLspConfig()),
			onStatusChange: () => emitStatus(pi, runtime),
		});
		emitStatus(pi, runtime);
	});

	pi.on("session_shutdown", async () => {
		const current = runtime;
		runtime = undefined;
		emitStatus(pi, runtime);
		await current?.shutdown();
	});

	registerLspTool(pi, () => runtime);

	pi.on("tool_result", async (event) => {
		if (event.isError || runtime === undefined) return;
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit")
			return;
		const path = pathFromToolInput(event.input);
		if (path === undefined) return;
		await runtime.touchRunningFile(path);
	});

	pi.registerCommand("lsp-status", {
		description: "Show LSP extension status for the current project",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatus(runtime), "info");
		},
	});

	pi.registerCommand("lsp-permissions", {
		description: "Show stored LSP spawn permissions for the current repository",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await Effect.runPromise(permissionSummary(ctx.cwd)), "info");
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
			ctx.ui.notify(await Effect.runPromise(setPermission(ctx.cwd, serverId, "allow")), "info");
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
			ctx.ui.notify(await Effect.runPromise(setPermission(ctx.cwd, serverId, "deny")), "info");
		},
	});

	pi.registerCommand("lsp-reset", {
		description: "Reset LSP permission for this repository: /lsp-reset <server|all>",
		handler: async (args, ctx) => {
			ctx.ui.notify(await Effect.runPromise(resetPermission(ctx.cwd, args)), "info");
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart LSP clients: /lsp-restart <server|all>",
		handler: async (args, ctx) => {
			if (runtime === undefined) {
				ctx.ui.notify("LSP runtime is not initialized.", "warning");
				return;
			}
			const serverId = parseServerId(args);
			await runtime.restart(serverId === "all" ? undefined : serverId);
			emitStatus(pi, runtime);
			ctx.ui.notify(
				serverId === undefined || serverId === "all"
					? "Restarted all LSP clients."
					: `Restarted ${serverId}.`,
				"info",
			);
		},
	});
}
