import { extname, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { LspClient, type LspClientStatus } from "./client";
import { findRepositoryRoot } from "./paths";
import { LspPermissionStore } from "./permissions";
import {
	buildServerRegistry,
	displayRoot,
	findServerRoot,
	matchesExtension,
	spawnServer,
	type LspServerDefinition,
} from "./server";
import type { LspConfig, LspPermission } from "./types";

export type LspCapability = "navigation" | "diagnostics";

export interface LocatedClient {
	client: LspClient;
	definition: LspServerDefinition;
}

export interface LspRuntimeStatus extends LspClientStatus {
	displayRoot: string;
}

export interface LspUnavailable {
	serverId: string;
	reason: string;
}

export interface ClientResolution {
	clients: ReadonlyArray<LocatedClient>;
	unavailable: ReadonlyArray<LspUnavailable>;
}

interface RuntimeOptions {
	cwd: string;
	config: LspConfig;
}

const clientKey = (root: string, serverId: string): string => `${root}\u0000${serverId}`;

export class LspRuntime {
	readonly cwd: string;

	private readonly registry: ReadonlyMap<string, LspServerDefinition>;
	private readonly clients = new Map<string, LspClient>();
	private readonly clientDefinitions = new Map<string, LspServerDefinition>();
	private readonly broken = new Map<string, string>();
	private shuttingDown = false;

	constructor(options: RuntimeOptions) {
		this.cwd = options.cwd;
		this.registry = buildServerRegistry(options.config);
	}

	serverIds(): ReadonlyArray<string> {
		return [...this.registry.keys()].sort();
	}

	status(): ReadonlyArray<LspRuntimeStatus> {
		return [...this.clients.values()].map((client) => ({
			...client.status,
			displayRoot: displayRoot(client.root, this.cwd),
		}));
	}

	runningClients(capability: LspCapability): ReadonlyArray<LocatedClient> {
		const clients: LocatedClient[] = [];
		for (const client of this.clients.values()) {
			const definition = this.clientDefinitions.get(clientKey(client.root, client.serverId));
			if (definition === undefined || !definition.capabilities[capability]) continue;
			clients.push({ client, definition });
		}
		return clients;
	}

	diagnostics(
		file?: string,
	): ReadonlyMap<string, ReadonlyArray<import("vscode-languageserver-types").Diagnostic>> {
		const result = new Map<
			string,
			ReadonlyArray<import("vscode-languageserver-types").Diagnostic>
		>();
		const resolvedFile =
			file === undefined
				? undefined
				: resolve(this.cwd, file.startsWith("@") ? file.slice(1) : file);
		for (const client of this.clients.values()) {
			for (const [diagnosticFile, diagnostics] of client.diagnostics.entries()) {
				if (resolvedFile !== undefined && diagnosticFile !== resolvedFile) continue;
				result.set(diagnosticFile, [...(result.get(diagnosticFile) ?? []), ...diagnostics]);
			}
		}
		return result;
	}

	async restart(serverId?: string): Promise<void> {
		const keys = [...this.clients.entries()]
			.filter(([, client]) => serverId === undefined || client.serverId === serverId)
			.map(([key]) => key);

		await Promise.all(
			keys.map(async (key) => {
				const client = this.clients.get(key);
				this.clients.delete(key);
				this.clientDefinitions.delete(key);
				await client?.shutdown();
			}),
		);

		for (const key of this.broken.keys()) {
			if (serverId === undefined || key.endsWith(`\u0000${serverId}`)) {
				this.broken.delete(key);
			}
		}
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const clients = [...this.clients.values()];
		this.clients.clear();
		this.clientDefinitions.clear();
		await Promise.all(clients.map((client) => client.shutdown()));
	}

	async clientsForFile(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Promise<ClientResolution> {
		const file = resolve(ctx.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
		const matches = await this.matchingServers(file, capability);
		const clients: LocatedClient[] = [];
		const unavailable: LspUnavailable[] = [];

		for (const match of matches) {
			const key = clientKey(match.root, match.definition.id);
			const existing = this.clients.get(key);
			if (existing !== undefined) {
				await existing.open(file, options.waitForDiagnostics ?? false).catch(() => undefined);
				clients.push({ client: existing, definition: match.definition });
				continue;
			}

			const brokenReason = this.broken.get(key);
			if (brokenReason !== undefined) {
				unavailable.push({ serverId: match.definition.id, reason: brokenReason });
				continue;
			}

			if (!options.prompt) {
				continue;
			}

			const permission = await this.permissionFor(match.definition, match.root, ctx);
			if (permission !== "allow") {
				unavailable.push({
					serverId: match.definition.id,
					reason: `Spawn permission is ${permission}.`,
				});
				continue;
			}

			const client = await this.spawnClient(match.definition, match.root, file);
			if (client === undefined) {
				const reason = `No ${match.definition.label} server binary found. ${match.definition.installHint}`;
				unavailable.push({ serverId: match.definition.id, reason });
				continue;
			}

			await client.open(file, options.waitForDiagnostics ?? false).catch(() => undefined);
			clients.push({ client, definition: match.definition });
		}

		return { clients, unavailable };
	}

	async touchRunningFile(filePath: string): Promise<void> {
		const file = resolve(this.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
		await Promise.all(
			[...this.clients.values()].map(async (client) => {
				const definition = this.clientDefinitions.get(clientKey(client.root, client.serverId));
				if (definition === undefined || !matchesExtension(definition, file)) return;
				await client.open(file, false).catch(() => undefined);
			}),
		);
	}

	private async matchingServers(
		file: string,
		capability: LspCapability,
	): Promise<ReadonlyArray<{ definition: LspServerDefinition; root: string }>> {
		if (extname(file) === "") return [];
		const matches: Array<{ definition: LspServerDefinition; root: string }> = [];
		for (const definition of this.registry.values()) {
			if (!definition.capabilities[capability]) continue;
			if (!matchesExtension(definition, file)) continue;
			const root = await findServerRoot(file, this.cwd, definition);
			if (root === undefined) continue;
			matches.push({ definition, root });
		}
		return matches;
	}

	private async permissionFor(
		definition: LspServerDefinition,
		root: string,
		ctx: ExtensionContext,
	): Promise<LspPermission> {
		const repoRoot = await findRepositoryRoot(root);
		const store = await LspPermissionStore.load();
		const existing = store.get(repoRoot, definition.id);
		if (existing !== undefined) return existing;

		if (!ctx.hasUI) {
			return "deny";
		}

		const approved = await ctx.ui.confirm(
			"Start LSP server?",
			`Start ${definition.label} (${definition.id}) for ${repoRoot}? This preference will be stored globally for this repository path.`,
		);
		const permission: LspPermission = approved ? "allow" : "deny";
		await store.set(repoRoot, definition.id, permission);
		return permission;
	}

	private async spawnClient(
		definition: LspServerDefinition,
		root: string,
		file: string,
	): Promise<LspClient | undefined> {
		const key = clientKey(root, definition.id);
		try {
			const handle = await spawnServer(definition, root, this.cwd);
			if (handle === undefined) return undefined;
			const client = await LspClient.create(handle);
			this.clients.set(key, client);
			this.clientDefinitions.set(key, definition);
			return client;
		} catch (error) {
			const reason = error instanceof Error ? error.message : `Failed to start ${definition.id}`;
			this.broken.set(key, `${reason} (${file})`);
			return undefined;
		}
	}
}
