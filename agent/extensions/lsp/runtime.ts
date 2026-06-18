import { extname, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Layer, ManagedRuntime, SynchronizedRef } from "effect";

import { LspClient } from "./client";
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
import { LspRuntimeSession } from "./runtime-session";
import { makeRuntimeState, type RuntimeState } from "./runtime-state";
import type {
	ClientResolution,
	LocatedClient,
	LspCapability,
	LspRuntimeStatus,
	LspUnavailable,
} from "./runtime-types";
import type { LspConfig, LspPermission } from "./types";

export type {
	ClientResolution,
	LocatedClient,
	LspCapability,
	LspRuntimeStatus,
	LspUnavailable,
} from "./runtime-types";

interface RuntimeOptions {
	cwd: string;
	config: LspConfig;
	onStatusChange?: () => void;
}

const clientKey = (root: string, serverId: string): string => `${root}\u0000${serverId}`;

const isBrokenClient = (client: LspClient): boolean => client.status.status === "broken";

const errorReason = (error: unknown, fallback: string): string => {
	if (typeof error === "object" && error !== null && "reason" in error) {
		const reason = (error as { reason?: unknown }).reason;
		if (typeof reason === "string") return reason;
	}
	return error instanceof Error && error.message ? error.message : fallback;
};

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

	private restartEffect(serverId?: string): Effect.Effect<void, unknown> {
		return Effect.suspend(() => {
			const keys = [...this.clients.entries()]
				.filter(([, client]) => serverId === undefined || client.serverId === serverId)
				.map(([key]) => key);

			return Effect.forEach(
				keys,
				(key) => {
					const client = this.clients.get(key);
					this.clients.delete(key);
					this.clientDefinitions.delete(key);
					return client === undefined
						? Effect.succeed(undefined)
						: Effect.tryPromise(() => client.shutdown());
				},
				{ concurrency: "unbounded", discard: true },
			).pipe(
				Effect.map(() => {
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
				}),
			);
		});
	}

	private shutdownEffect(): Effect.Effect<void, unknown> {
		return Effect.suspend(() => {
			if (this.shuttingDown) return Effect.succeed(undefined);
			this.shuttingDown = true;
			const clients = [...this.clients.values()];
			this.clients.clear();
			this.clientDefinitions.clear();
			this.spawning.clear();
			this.notifyStatusChange();
			return Effect.forEach(clients, (client) => Effect.tryPromise(() => client.shutdown()), {
				concurrency: "unbounded",
				discard: true,
			});
		});
	}

	private clientsForFileEffect(
		filePath: string,
		capability: LspCapability,
		ctx: ExtensionContext,
		options: { prompt: boolean; waitForDiagnostics?: boolean },
	): Effect.Effect<ClientResolution, unknown> {
		// oxlint-disable-next-line typescript/no-this-alias
		const runtime = this;
		return Effect.gen(function* () {
			if (runtime.shuttingDown) return yield* Effect.fail(lspRuntimeShuttingDown());
			const file = resolve(ctx.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
			const matches = yield* runtime.matchingServersEffect(file, capability);
			const clients: LocatedClient[] = [];
			const unavailable: LspUnavailable[] = [];

			for (const match of matches) {
				const key = clientKey(match.root, match.definition.id);
				const existing = runtime.clients.get(key);
				if (existing !== undefined) {
					if (isBrokenClient(existing)) {
						const reason = `${match.definition.label} server is broken. Use /lsp-restart ${match.definition.id} to retry.`;
						runtime.markBroken(key, reason);
						unavailable.push({ serverId: match.definition.id, reason });
						continue;
					}

					yield* runtime.openClientEffect(existing, file, options.waitForDiagnostics ?? false);
					if (isBrokenClient(existing)) {
						const reason = `${match.definition.label} server is broken. Use /lsp-restart ${match.definition.id} to retry.`;
						runtime.markBroken(key, reason);
						unavailable.push({ serverId: match.definition.id, reason });
						continue;
					}
					clients.push({ client: existing, definition: match.definition });
					continue;
				}

				const brokenReason = runtime.broken.get(key);
				if (brokenReason !== undefined) {
					unavailable.push({ serverId: match.definition.id, reason: brokenReason });
					continue;
				}

				const inflight = runtime.spawning.get(key);
				if (inflight !== undefined) {
					const client = yield* Deferred.await(inflight);
					if (runtime.shuttingDown) return yield* Effect.fail(lspRuntimeShuttingDown());
					if (client === undefined) {
						const reason =
							runtime.broken.get(key) ??
							`No ${match.definition.label} server binary found. ${match.definition.installHint}`;
						unavailable.push({ serverId: match.definition.id, reason });
						continue;
					}
					yield* runtime.openClientEffect(client, file, options.waitForDiagnostics ?? false);
					clients.push({ client, definition: match.definition });
					continue;
				}

				if (!options.prompt) continue;

				const deferred = Deferred.makeUnsafe<LspClient | undefined, Error>();
				runtime.spawning.set(key, deferred);
				const spawned = yield* runtime.spawnForMatchEffect(match, key, file, ctx, deferred).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (runtime.spawning.get(key) === deferred) runtime.spawning.delete(key);
						}),
					),
				);
				if (spawned === undefined) {
					const reason =
						runtime.broken.get(key) ??
						`No ${match.definition.label} server binary found. ${match.definition.installHint}`;
					unavailable.push({ serverId: match.definition.id, reason });
					continue;
				}
				if (spawned.permissionDenied !== undefined) {
					unavailable.push({
						serverId: match.definition.id,
						reason: `Spawn permission is ${spawned.permissionDenied}.`,
					});
					continue;
				}
				yield* runtime.openClientEffect(spawned.client, file, options.waitForDiagnostics ?? false);
				clients.push({ client: spawned.client, definition: match.definition });
			}

			return { clients, unavailable };
		});
	}

	private touchRunningFileEffect(filePath: string): Effect.Effect<void, unknown> {
		return Effect.suspend(() => {
			const file = resolve(this.cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
			return Effect.forEach(
				[...this.clients.values()],
				(client) => {
					const key = clientKey(client.root, client.serverId);
					const definition = this.clientDefinitions.get(key);
					if (isBrokenClient(client)) {
						this.markBroken(key, `${client.label} server is broken.`);
						return Effect.succeed(undefined);
					}
					if (definition === undefined || !matchesExtension(definition, file)) {
						return Effect.succeed(undefined);
					}
					return this.openClientEffect(client, file, false).pipe(
						Effect.map(() => {
							if (isBrokenClient(client)) this.markBroken(key, `${client.label} server is broken.`);
						}),
					);
				},
				{ concurrency: "unbounded", discard: true },
			);
		});
	}

	private matchingServersEffect(
		file: string,
		capability: LspCapability,
	): Effect.Effect<ReadonlyArray<{ definition: LspServerDefinition; root: string }>, unknown> {
		// oxlint-disable-next-line typescript/no-this-alias
		const runtime = this;
		return Effect.gen(function* () {
			if (extname(file) === "") return [];
			const matches: Array<{ definition: LspServerDefinition; root: string }> = [];
			for (const definition of runtime.registry.values()) {
				if (!definition.capabilities[capability]) continue;
				if (!matchesExtension(definition, file)) continue;
				const root = yield* findServerRoot(file, runtime.cwd, definition);
				if (root === undefined) continue;
				matches.push({ definition, root });
			}
			return matches;
		});
	}

	private permissionForEffect(
		definition: LspServerDefinition,
		root: string,
		ctx: ExtensionContext,
	): Effect.Effect<LspPermission, unknown> {
		return Effect.gen(function* () {
			const repoRoot = yield* findRepositoryRoot(root);
			const store = yield* LspPermissionStore.load();
			const existing = store.get(repoRoot, definition.id);
			if (existing !== undefined) return existing;

			if (!ctx.hasUI) return "deny";

			const approved = yield* Effect.tryPromise(() =>
				ctx.ui.confirm(
					"Start LSP server?",
					`Start ${definition.label} (${definition.id}) for ${repoRoot}? This preference will be stored globally for this repository path.`,
				),
			);
			const permission: LspPermission = approved ? "allow" : "deny";
			yield* store.set(repoRoot, definition.id, permission);
			return permission;
		});
	}

	private markBroken(key: string, reason: string): void {
		const previous = this.broken.get(key);
		this.broken.set(key, reason);
		if (previous !== reason) this.notifyStatusChange();
	}

	private notifyStatusChange(): void {
		this.onStatusChange?.();
	}

	private spawnForMatchEffect(
		match: { definition: LspServerDefinition; root: string },
		key: string,
		file: string,
		ctx: ExtensionContext,
		deferred: Deferred.Deferred<LspClient | undefined, Error>,
	): Effect.Effect<
		| { readonly client: LspClient; readonly permissionDenied?: never }
		| { readonly client?: never; readonly permissionDenied: LspPermission }
		| undefined,
		unknown
	> {
		// oxlint-disable-next-line typescript/no-this-alias
		const runtime = this;
		return Effect.gen(function* () {
			const permission = yield* runtime.permissionForEffect(match.definition, match.root, ctx);
			if (runtime.shuttingDown) return yield* Effect.fail(lspRuntimeShuttingDown());
			if (permission !== "allow") {
				yield* Deferred.succeed(deferred, undefined);
				return { permissionDenied: permission };
			}

			const client = yield* runtime.spawnClientEffect(match.definition, match.root, file);
			if (runtime.shuttingDown) return yield* Effect.fail(lspRuntimeShuttingDown());
			yield* Deferred.succeed(deferred, client);
			return client === undefined ? undefined : { client };
		}).pipe(
			Effect.catch((error) => {
				const normalized = error instanceof Error ? error : new Error(String(error));
				return Deferred.fail(deferred, normalized).pipe(
					Effect.flatMap(() => Effect.fail(normalized)),
				);
			}),
		);
	}

	private openClientEffect(
		client: LspClient,
		file: string,
		waitForDiagnostics: boolean,
	): Effect.Effect<void, unknown> {
		return Effect.tryPromise(() => client.open(file, waitForDiagnostics)).pipe(
			Effect.catch(() => Effect.succeed(undefined)),
		);
	}

	private spawnClientEffect(
		definition: LspServerDefinition,
		root: string,
		file: string,
	): Effect.Effect<LspClient | undefined, unknown> {
		// oxlint-disable-next-line typescript/no-this-alias
		const runtime = this;
		return Effect.gen(function* () {
			const key = clientKey(root, definition.id);
			const handle = yield* spawnServer(definition, root, runtime.cwd).pipe(
				Effect.catch((error) => {
					const reason = errorReason(error, `Failed to start ${definition.id}`);
					runtime.markBroken(key, `${reason} (${file})`);
					return Effect.succeed(undefined);
				}),
			);
			if (handle === undefined) return undefined;

			const client = yield* Effect.tryPromise({
				try: () => LspClient.create(handle),
				catch: (cause) => cause,
			}).pipe(
				Effect.catch((error) => {
					if (!handle.process.killed) handle.process.kill("SIGTERM");
					const reason = errorReason(error, `Failed to start ${definition.id}`);
					runtime.markBroken(key, `${reason} (${file})`);
					return Effect.succeed(undefined);
				}),
			);
			if (client === undefined) return undefined;
			if (runtime.shuttingDown) {
				yield* Effect.tryPromise(() => client.shutdown()).pipe(
					Effect.catch(() => Effect.succeed(undefined)),
				);
				return undefined;
			}
			runtime.clients.set(key, client);
			runtime.clientDefinitions.set(key, definition);
			runtime.notifyStatusChange();
			return client;
		});
	}
}
