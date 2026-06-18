import { extname, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Deferred, Effect, Layer, ManagedRuntime, SynchronizedRef } from "effect";

import { LspClient, type LspClientStatus } from "./client";
import { lspRuntimeShuttingDown } from "./errors";
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
	onStatusChange?: () => void;
}

interface RuntimeState {
	clients: Map<string, LspClient>;
	clientDefinitions: Map<string, LspServerDefinition>;
	broken: Map<string, string>;
	spawning: Map<string, Deferred.Deferred<LspClient | undefined, Error>>;
	shuttingDown: boolean;
	activeOperations: number;
	disposeRequested: boolean;
	disposed: boolean;
}

const makeRuntimeState = (): RuntimeState => ({
	clients: new Map(),
	clientDefinitions: new Map(),
	broken: new Map(),
	spawning: new Map(),
	shuttingDown: false,
	activeOperations: 0,
	disposeRequested: false,
	disposed: false,
});

const clientKey = (root: string, serverId: string): string => `${root}\u0000${serverId}`;

const isBrokenClient = (client: LspClient): boolean => client.status.status === "broken";

const errorReason = (error: unknown, fallback: string): string => {
	if (typeof error === "object" && error !== null && "reason" in error) {
		const reason = (error as { reason?: unknown }).reason;
		if (typeof reason === "string") return reason;
	}
	return error instanceof Error && error.message ? error.message : fallback;
};

class LspRuntimeSession extends Context.Service<
	LspRuntimeSession,
	{
		serverIds: Effect.Effect<ReadonlyArray<string>>;
		status: Effect.Effect<ReadonlyArray<LspRuntimeStatus>>;
		runningClients(capability: LspCapability): Effect.Effect<ReadonlyArray<LocatedClient>>;
		diagnostics(
			file?: string,
		): Effect.Effect<
			ReadonlyMap<string, ReadonlyArray<import("vscode-languageserver-types").Diagnostic>>
		>;
		restart(serverId?: string): Effect.Effect<void>;
		shutdown: Effect.Effect<void>;
		clientsForFile(
			filePath: string,
			capability: LspCapability,
			ctx: ExtensionContext,
			options: { prompt: boolean; waitForDiagnostics?: boolean },
		): Effect.Effect<ClientResolution, unknown>;
		touchRunningFile(filePath: string): Effect.Effect<void>;
	}
>()("pi/lsp/LspRuntimeSession") {}

export class LspRuntime {
	readonly cwd: string;

	private readonly registry: ReadonlyMap<string, LspServerDefinition>;
	private readonly state = SynchronizedRef.makeUnsafe(makeRuntimeState());
	private readonly onStatusChange?: () => void;
	private readonly sessionRuntime: ManagedRuntime.ManagedRuntime<LspRuntimeSession, never>;

	constructor(options: RuntimeOptions) {
		this.cwd = options.cwd;
		this.registry = buildServerRegistry(options.config);
		this.onStatusChange = options.onStatusChange;
		this.sessionRuntime = ManagedRuntime.make(
			Layer.succeed(
				LspRuntimeSession,
				LspRuntimeSession.of({
					serverIds: this.serverIdsEffect(),
					status: this.statusEffect(),
					runningClients: (capability) => this.runningClientsEffect(capability),
					diagnostics: (file) => this.diagnosticsEffect(file),
					restart: (serverId) => this.restartEffect(serverId),
					shutdown: this.shutdownEffect(),
					clientsForFile: (filePath, capability, ctx, options) =>
						this.clientsForFileEffect(filePath, capability, ctx, options),
					touchRunningFile: (filePath) => this.touchRunningFileEffect(filePath),
				}),
			),
		);
	}

	private currentState(): RuntimeState {
		return SynchronizedRef.getUnsafe(this.state);
	}

	private get clients(): RuntimeState["clients"] {
		return this.currentState().clients;
	}

	private get clientDefinitions(): RuntimeState["clientDefinitions"] {
		return this.currentState().clientDefinitions;
	}

	private get broken(): RuntimeState["broken"] {
		return this.currentState().broken;
	}

	private get spawning(): RuntimeState["spawning"] {
		return this.currentState().spawning;
	}

	private get shuttingDown(): boolean {
		return this.currentState().shuttingDown;
	}

	private set shuttingDown(value: boolean) {
		this.currentState().shuttingDown = value;
	}

	serverIds(): ReadonlyArray<string> {
		if (this.currentState().disposed) return Effect.runSync(this.serverIdsEffect());
		return this.sessionRuntime.runSync(LspRuntimeSession.use((session) => session.serverIds));
	}

	status(): ReadonlyArray<LspRuntimeStatus> {
		if (this.currentState().disposed) return Effect.runSync(this.statusEffect());
		return this.sessionRuntime.runSync(LspRuntimeSession.use((session) => session.status));
	}

	runningClients(capability: LspCapability): ReadonlyArray<LocatedClient> {
		if (this.currentState().disposed) return Effect.runSync(this.runningClientsEffect(capability));
		return this.sessionRuntime.runSync(
			LspRuntimeSession.use((session) => session.runningClients(capability)),
		);
	}

	diagnostics(
		file?: string,
	): ReadonlyMap<string, ReadonlyArray<import("vscode-languageserver-types").Diagnostic>> {
		if (this.currentState().disposed) return Effect.runSync(this.diagnosticsEffect(file));
		return this.sessionRuntime.runSync(
			LspRuntimeSession.use((session) => session.diagnostics(file)),
		);
	}

	async restart(serverId?: string): Promise<void> {
		await this.runOperation(LspRuntimeSession.use((session) => session.restart(serverId)));
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		await this.sessionRuntime.runPromise(LspRuntimeSession.use((session) => session.shutdown));
		this.currentState().disposeRequested = true;
		await this.disposeIfIdle();
	}

	async clientsForFile(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Promise<ClientResolution> {
		return await this.runOperation(
			LspRuntimeSession.use((session) =>
				session.clientsForFile(filePath, capability, ctx, options),
			),
		);
	}

	async touchRunningFile(filePath: string): Promise<void> {
		await this.runOperation(LspRuntimeSession.use((session) => session.touchRunningFile(filePath)));
	}

	private async runOperation<A, E>(effect: Effect.Effect<A, E, LspRuntimeSession>): Promise<A> {
		const state = this.currentState();
		if (state.disposed) throw lspRuntimeShuttingDown();
		state.activeOperations += 1;
		try {
			return await this.sessionRuntime.runPromise(effect);
		} finally {
			state.activeOperations -= 1;
			await this.disposeIfIdle();
		}
	}

	private async disposeIfIdle(): Promise<void> {
		const state = this.currentState();
		if (!state.disposeRequested || state.disposed || state.activeOperations > 0) return;
		state.disposed = true;
		await this.sessionRuntime.dispose();
	}

	private serverIdsEffect(): Effect.Effect<ReadonlyArray<string>> {
		return Effect.sync(() => [...this.registry.keys()].sort());
	}

	private statusEffect(): Effect.Effect<ReadonlyArray<LspRuntimeStatus>> {
		return Effect.sync(() =>
			[...this.clients.values()].map((client) => ({
				...client.status,
				displayRoot: displayRoot(client.root, this.cwd),
			})),
		);
	}

	private runningClientsEffect(
		capability: LspCapability,
	): Effect.Effect<ReadonlyArray<LocatedClient>> {
		return Effect.sync(() => {
			const clients: LocatedClient[] = [];
			for (const client of this.clients.values()) {
				const key = clientKey(client.root, client.serverId);
				const definition = this.clientDefinitions.get(key);
				if (isBrokenClient(client)) {
					this.broken.set(key, `${client.label} server is broken.`);
					continue;
				}
				if (definition === undefined || !definition.capabilities[capability]) continue;
				clients.push({ client, definition });
			}
			return clients;
		});
	}

	private diagnosticsEffect(
		file?: string,
	): Effect.Effect<
		ReadonlyMap<string, ReadonlyArray<import("vscode-languageserver-types").Diagnostic>>
	> {
		return Effect.sync(() => {
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
		});
	}

	private restartEffect(serverId?: string): Effect.Effect<void> {
		return Effect.promise(async () => {
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
			if (keys.length > 0) this.notifyStatusChange();

			for (const key of this.spawning.keys()) {
				if (serverId === undefined || key.endsWith(`\u0000${serverId}`)) {
					this.spawning.delete(key);
				}
			}

			for (const key of this.broken.keys()) {
				if (serverId === undefined || key.endsWith(`\u0000${serverId}`)) {
					this.broken.delete(key);
				}
			}
		});
	}

	private shutdownEffect(): Effect.Effect<void> {
		return Effect.promise(async () => {
			if (this.shuttingDown) return;
			this.shuttingDown = true;
			const clients = [...this.clients.values()];
			this.clients.clear();
			this.clientDefinitions.clear();
			this.spawning.clear();
			this.notifyStatusChange();
			await Promise.all(clients.map((client) => client.shutdown()));
		});
	}

	private clientsForFileEffect(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Effect.Effect<ClientResolution, unknown> {
		return Effect.tryPromise({
			try: () => this.clientsForFilePromise(filePath, capability, ctx, options),
			catch: (cause) => cause,
		});
	}

	private async clientsForFilePromise(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Promise<ClientResolution> {
		if (this.shuttingDown) throw lspRuntimeShuttingDown();
		const file = resolve(ctx.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
		const matches = await this.matchingServers(file, capability);
		const clients: LocatedClient[] = [];
		const unavailable: LspUnavailable[] = [];

		for (const match of matches) {
			const key = clientKey(match.root, match.definition.id);
			const existing = this.clients.get(key);
			if (existing !== undefined) {
				if (isBrokenClient(existing)) {
					const reason = `${match.definition.label} server is broken. Use /lsp-restart ${match.definition.id} to retry.`;
					this.markBroken(key, reason);
					unavailable.push({ serverId: match.definition.id, reason });
					continue;
				}

				await existing.open(file, options.waitForDiagnostics ?? false).catch(() => undefined);
				if (isBrokenClient(existing)) {
					const reason = `${match.definition.label} server is broken. Use /lsp-restart ${match.definition.id} to retry.`;
					this.markBroken(key, reason);
					unavailable.push({ serverId: match.definition.id, reason });
					continue;
				}
				clients.push({ client: existing, definition: match.definition });
				continue;
			}

			const brokenReason = this.broken.get(key);
			if (brokenReason !== undefined) {
				unavailable.push({ serverId: match.definition.id, reason: brokenReason });
				continue;
			}

			const inflight = this.spawning.get(key);
			if (inflight !== undefined) {
				const client = await Effect.runPromise(Deferred.await(inflight));
				if (this.shuttingDown) throw lspRuntimeShuttingDown();
				if (client === undefined) {
					const reason =
						this.broken.get(key) ??
						`No ${match.definition.label} server binary found. ${match.definition.installHint}`;
					unavailable.push({ serverId: match.definition.id, reason });
					continue;
				}
				await client.open(file, options.waitForDiagnostics ?? false).catch(() => undefined);
				clients.push({ client, definition: match.definition });
				continue;
			}

			if (!options.prompt) {
				continue;
			}

			const deferred = Deferred.makeUnsafe<LspClient | undefined, Error>();
			this.spawning.set(key, deferred);
			try {
				const permission = await this.permissionFor(match.definition, match.root, ctx);
				if (this.shuttingDown) throw lspRuntimeShuttingDown();
				if (permission !== "allow") {
					await Effect.runPromise(Deferred.succeed(deferred, undefined));
					unavailable.push({
						serverId: match.definition.id,
						reason: `Spawn permission is ${permission}.`,
					});
					continue;
				}

				const client = await this.spawnClient(match.definition, match.root, file);
				if (this.shuttingDown) throw lspRuntimeShuttingDown();
				await Effect.runPromise(Deferred.succeed(deferred, client));
				if (client === undefined) {
					const reason =
						this.broken.get(key) ??
						`No ${match.definition.label} server binary found. ${match.definition.installHint}`;
					unavailable.push({ serverId: match.definition.id, reason });
					continue;
				}

				await client.open(file, options.waitForDiagnostics ?? false).catch(() => undefined);
				clients.push({ client, definition: match.definition });
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				await Effect.runPromise(Deferred.fail(deferred, normalized));
				throw normalized;
			} finally {
				if (this.spawning.get(key) === deferred) {
					this.spawning.delete(key);
				}
			}
		}

		return { clients, unavailable };
	}

	private touchRunningFileEffect(filePath: string): Effect.Effect<void> {
		return Effect.promise(() => this.touchRunningFilePromise(filePath));
	}

	private async touchRunningFilePromise(filePath: string): Promise<void> {
		const file = resolve(this.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
		await Promise.all(
			[...this.clients.values()].map(async (client) => {
				const key = clientKey(client.root, client.serverId);
				const definition = this.clientDefinitions.get(key);
				if (isBrokenClient(client)) {
					this.markBroken(key, `${client.label} server is broken.`);
					return;
				}
				if (definition === undefined || !matchesExtension(definition, file)) return;
				await client.open(file, false).catch(() => undefined);
				if (isBrokenClient(client)) {
					this.markBroken(key, `${client.label} server is broken.`);
				}
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

	private markBroken(key: string, reason: string): void {
		const previous = this.broken.get(key);
		this.broken.set(key, reason);
		if (previous !== reason) this.notifyStatusChange();
	}

	private notifyStatusChange(): void {
		this.onStatusChange?.();
	}

	private async spawnClient(
		definition: LspServerDefinition,
		root: string,
		file: string,
	): Promise<LspClient | undefined> {
		const key = clientKey(root, definition.id);
		const handle = await spawnServer(definition, root, this.cwd).catch((error: unknown) => {
			const reason = errorReason(error, `Failed to start ${definition.id}`);
			this.markBroken(key, `${reason} (${file})`);
			return undefined;
		});
		if (handle === undefined) return undefined;

		try {
			const client = await LspClient.create(handle);
			if (this.shuttingDown) {
				await client.shutdown();
				return undefined;
			}
			this.clients.set(key, client);
			this.clientDefinitions.set(key, definition);
			this.notifyStatusChange();
			return client;
		} catch (error) {
			if (!handle.process.killed) handle.process.kill("SIGTERM");
			const reason = errorReason(error, `Failed to start ${definition.id}`);
			this.markBroken(key, `${reason} (${file})`);
			return undefined;
		}
	}
}
