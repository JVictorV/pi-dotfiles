import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, References, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import { getRuntimeDir, safeFilePart } from "./runtime-files";

const RPC_OPEN_TIMEOUT = "250 millis";
const RPC_TIMEOUT = "1 second";
const RPC_DIRECTORY_MODE = 0o700;
const RPC_SOCKET_MODE = 0o600;
const MAX_FINAL_MESSAGE_WIRE_CHARS = 256_000;

const SubagentFinishedPayloadFields = {
	name: Schema.String,
	status: Schema.Literals(["done", "blocked"]),
	finalMessage: Schema.String.check(Schema.isMaxLength(MAX_FINAL_MESSAGE_WIRE_CHARS)),
	sentAtMs: Schema.Number,
	completionId: Schema.optional(Schema.String),
	armId: Schema.optional(Schema.String),
};

const SubagentFinished = Rpc.make("SubagentFinished", {
	payload: SubagentFinishedPayloadFields,
	success: Schema.String,
});

const PersistedSubagentFinished = Schema.fromJsonString(
	Schema.Struct(SubagentFinishedPayloadFields),
);
const decodePersistedSubagentFinished = Schema.decodeUnknownEffect(PersistedSubagentFinished);

const SubagentRpcs = RpcGroup.make(SubagentFinished);

/** Payload sent by a subagent when its pi turn finishes. */
export type SubagentFinishedPayload = Rpc.PayloadConstructor<typeof SubagentFinished>;

/** Expected failure while starting the session-scoped subagent result RPC server. */
export class SubagentRpcServerStartFailed extends Schema.TaggedErrorClass<SubagentRpcServerStartFailed>()(
	"SubagentRpcServerStartFailed",
	{
		message: Schema.String,
		socketPath: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** Failure to deliver or persist a settled subagent completion. */
export class SubagentCompletionDeliveryFailed extends Schema.TaggedErrorClass<SubagentCompletionDeliveryFailed>()(
	"SubagentCompletionDeliveryFailed",
	{
		message: Schema.String,
		name: Schema.String,
		socketPath: Schema.String,
	},
) {}

/** A running subagent result RPC server owned by one orchestrator pi session. */
export interface SubagentRpcServer {
	/** Unix domain socket path that spawned subagents should connect to. */
	readonly socketPath: string;
	/** Stop the server and remove its socket file. Safe to call more than once. */
	close(): Promise<void>;
}

/** Options for starting the orchestrator-side subagent result RPC server. */
export interface StartSubagentRpcServerOptions {
	/** Stable session owner id used to derive the socket path when `socketPath` is omitted. */
	readonly ownerId?: string;
	/** Explicit socket path, primarily for integration tests. */
	readonly socketPath?: string;
	/** Handler invoked for every received subagent completion payload. */
	onFinished(payload: SubagentFinishedPayload): void;
}

/** Options for sending a subagent completion payload to an orchestrator socket. */
export interface NotifySubagentFinishedOptions extends SubagentFinishedPayload {
	/** Unix domain socket path supplied by the orchestrator session. */
	readonly socketPath: string;
}

const rpcDirectory = (): string => path.join(getRuntimeDir(), "rpc");
const completionDirectory = (): string => path.join(getRuntimeDir(), "completion");
const completionPrefix = (name: string): string => `v2-${safeFilePart(name)}-`;
const completionPath = (payload: SubagentFinishedPayload): string => {
	const sentAt = String(Math.max(0, Math.floor(payload.sentAtMs))).padStart(16, "0");
	const completionId = safeFilePart(payload.completionId ?? randomUUID());
	return path.join(
		completionDirectory(),
		`${completionPrefix(payload.name)}${sentAt}-${completionId}.json`,
	);
};
const completionArmPath = (name: string): string =>
	path.join(completionDirectory(), `v1-${safeFilePart(name)}.arm`);

const removePersistedCompletion = (payload: SubagentFinishedPayload): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: () => rm(completionPath(payload), { force: true }),
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

const writePrivateRuntimeFile = (
	destination: string,
	content: string,
): Effect.Effect<boolean, never> =>
	Effect.tryPromise({
		try: async () => {
			const directory = completionDirectory();
			const temporary = `${destination}.${globalThis.process?.pid ?? "pid"}.${randomUUID()}.tmp`;
			await mkdir(directory, { recursive: true, mode: RPC_DIRECTORY_MODE });
			await chmod(directory, RPC_DIRECTORY_MODE);
			await writeFile(temporary, content, {
				encoding: "utf8",
				mode: RPC_SOCKET_MODE,
			});
			await rename(temporary, destination);
			await chmod(destination, RPC_SOCKET_MODE);
		},
		catch: () => undefined,
	}).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);

const persistCompletion = (payload: SubagentFinishedPayload): Effect.Effect<boolean, never> =>
	writePrivateRuntimeFile(completionPath(payload), JSON.stringify(payload));

/**
 * Publish the completion arm identity that a subagent run must report when it settles.
 *
 * @param name - Registered subagent name.
 * @param armId - Unique identity for the orchestrator action that armed the run.
 */
export const writeSubagentCompletionArm = (
	name: string,
	armId: string,
): Effect.Effect<boolean, never> => writePrivateRuntimeFile(completionArmPath(name), armId);

/**
 * Read the current completion arm identity for a subagent run.
 *
 * @param name - Registered subagent name.
 * @returns The current arm identity, or `undefined` when no orchestrator action published one.
 */
export const readSubagentCompletionArm = (name: string): Effect.Effect<string | undefined, never> =>
	Effect.tryPromise({
		try: async () => {
			const armId = (await readFile(completionArmPath(name), "utf8")).trim();
			return armId.length > 0 ? armId : undefined;
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.succeed(undefined)));

/**
 * Read and remove the latest durable completion fallback for a subagent.
 *
 * @param name - Registered subagent name.
 * @returns The persisted completion, or `undefined` when none is available or valid.
 */
export const takePersistedSubagentCompletion: (
	name: string,
) => Effect.Effect<SubagentFinishedPayload | undefined, never> = Effect.fnUntraced(
	function* (name) {
		const fileName = yield* Effect.tryPromise({
			try: async () => {
				const prefix = completionPrefix(name);
				const entries = await readdir(completionDirectory());
				return entries
					.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
					.sort()[0];
			},
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed(undefined)));
		if (fileName === undefined) {
			return undefined;
		}
		const filePath = path.join(completionDirectory(), fileName);
		const text = yield* Effect.tryPromise({
			try: () => readFile(filePath, "utf8"),
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed(undefined)));
		if (text === undefined) {
			return undefined;
		}
		const payload = yield* decodePersistedSubagentFinished(text).pipe(
			Effect.catch(() => Effect.succeed(undefined)),
		);
		yield* Effect.tryPromise({
			try: () => rm(filePath, { force: true }),
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.void));
		return payload;
	},
);

const mapStartFailure = (socketPath: string, cause: unknown): SubagentRpcServerStartFailed =>
	new SubagentRpcServerStartFailed({
		message: `Could not start herdr subagent RPC server at ${socketPath}`,
		socketPath,
		cause,
	});

const ensureSocketDirectory = (
	socketPath: string,
): Effect.Effect<void, SubagentRpcServerStartFailed> =>
	Effect.tryPromise({
		try: async () => {
			const directory = path.dirname(socketPath);
			await mkdir(directory, { recursive: true, mode: RPC_DIRECTORY_MODE });
			await chmod(directory, RPC_DIRECTORY_MODE);
			// Each server uses a random path and removes its own path on close. Do not age-sweep
			// the shared directory: an active orchestrator session can run longer than the age limit.
			await rm(socketPath, { force: true });
		},
		catch: (cause) => mapStartFailure(socketPath, cause),
	});

const removeSocket = (socketPath: string): Promise<void> => rm(socketPath, { force: true });

const runPromiseIgnoringFailure = (operation: () => Promise<unknown>): Promise<void> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: operation,
			catch: () => undefined,
		}).pipe(
			Effect.catch(() => Effect.void),
			Effect.asVoid,
		),
	);

const serverLayer = (
	socketPath: string,
	onFinished: (payload: SubagentFinishedPayload) => void,
) => {
	const handlers = SubagentRpcs.toLayer(
		SubagentRpcs.of({
			SubagentFinished: (payload) =>
				Effect.try({
					try: () => onFinished(payload),
					catch: () => undefined,
				}).pipe(
					Effect.catch(() => Effect.void),
					Effect.as("ok"),
				),
		}),
	);
	return RpcServer.layer(SubagentRpcs).pipe(
		Layer.provide(handlers),
		Layer.provideMerge(RpcServer.layerProtocolSocketServer),
		Layer.provideMerge(NodeSocketServer.layer({ path: socketPath })),
		Layer.provide(RpcSerialization.layerNdjson),
		// This side channel degrades to pane polling by design, so its internal
		// connection errors (e.g. EPIPE/ECONNRESET from clients that vanish after
		// notifying) are operational noise, not actionable failures. Suppress the
		// RPC server's Effect.logError output for this runtime only.
		Layer.provide(Layer.succeed(References.MinimumLogLevel, "None")),
	);
};

const OwnerSocketPublication = Schema.fromJsonString(Schema.Struct({ socketPath: Schema.String }));
const decodeOwnerSocketPublication = Schema.decodeUnknownEffect(OwnerSocketPublication);

const ownerPublicationPath = (ownerId: string): string =>
	path.join(rpcDirectory(), `owner-${safeFilePart(ownerId)}.json`);

/**
 * Publish the live orchestrator result socket for a herdr pane.
 *
 * Spawn-time env vars die with the original processes, so resumed sessions read this
 * publication to re-attach children to a reopened orchestrator's new socket.
 *
 * @param ownerId - Pane id of the orchestrator session.
 * @param socketPath - Live unix socket path of the orchestrator's result server.
 * @returns True when the publication was written.
 */
export const publishResultSocket = (
	ownerId: string,
	socketPath: string,
): Effect.Effect<boolean, never> =>
	writePrivateRuntimeFile(ownerPublicationPath(ownerId), JSON.stringify({ socketPath }));

/**
 * Read the published result socket path for a herdr pane.
 *
 * @param ownerId - Pane id of the orchestrator session.
 * @returns The published socket path, or undefined when absent or invalid.
 */
export const readPublishedResultSocket: (
	ownerId: string,
) => Effect.Effect<string | undefined, never> = Effect.fnUntraced(function* (ownerId) {
	const text = yield* Effect.tryPromise({
		try: () => readFile(ownerPublicationPath(ownerId), "utf8"),
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.succeed(undefined)));
	if (text === undefined) {
		return undefined;
	}
	return yield* decodeOwnerSocketPublication(text).pipe(
		Effect.map((publication) => publication.socketPath),
		Effect.catch(() => Effect.succeed(undefined)),
	);
});

/**
 * Remove the published result socket path for a herdr pane.
 *
 * @param ownerId - Pane id of the orchestrator session being shut down.
 * @returns Nothing; failures are ignored.
 */
export const unpublishResultSocket = (ownerId: string): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: () => rm(ownerPublicationPath(ownerId), { force: true }),
		catch: () => undefined,
	}).pipe(
		Effect.catch(() => Effect.void),
		Effect.asVoid,
	);

/**
 * Derive the unix socket path for one orchestrator session.
 *
 * @param ownerId - Pane id or process id identifying the orchestrator session.
 * @returns A socket path under the herdr-subagents runtime directory.
 */
export const subagentRpcSocketPath = (
	ownerId = String(globalThis.process?.pid ?? "pid"),
	nonce = randomUUID(),
): string => path.join(rpcDirectory(), `v1-${safeFilePart(ownerId)}-${safeFilePart(nonce)}.sock`);

/**
 * Start the orchestrator-side RPC server for direct subagent result handoff.
 *
 * The server unlinks any stale socket before listening and unlinks again when closed.
 * Startup failures are typed so callers can silently fall back to pane polling.
 *
 * @param options - Server path derivation and completion handler options.
 * @returns A running server handle with its socket path.
 */
export const startSubagentRpcServer: (
	options: StartSubagentRpcServerOptions,
) => Effect.Effect<SubagentRpcServer, SubagentRpcServerStartFailed> = Effect.fnUntraced(
	function* (options) {
		const socketPath = options.socketPath ?? subagentRpcSocketPath(options.ownerId);
		yield* ensureSocketDirectory(socketPath);
		// The RPC server owns socket-scoped resources independent of the CLI watcher runtime.
		const runtime = ManagedRuntime.make(serverLayer(socketPath, options.onFinished));
		let closed = false;
		const close = async (): Promise<void> => {
			if (closed) {
				return;
			}
			closed = true;
			await runPromiseIgnoringFailure(() => runtime.dispose());
			await runPromiseIgnoringFailure(() => removeSocket(socketPath));
		};
		return yield* Effect.tryPromise({
			try: async () => {
				await runtime.context();
				await chmod(socketPath, RPC_SOCKET_MODE);
				return { socketPath, close };
			},
			catch: (cause) => mapStartFailure(socketPath, cause),
		}).pipe(
			Effect.catch((error) =>
				Effect.promise(close).pipe(
					Effect.catch(() => Effect.void),
					Effect.andThen(Effect.fail(error)),
				),
			),
		);
	},
);

/**
 * Push a settled subagent completion to its orchestrator or durable outbox.
 *
 * Socket failures succeed when the durable fallback was written. Persistence
 * failures succeed when the orchestrator acknowledged the direct RPC.
 *
 * @param options - Socket path and subagent completion payload.
 * @returns An effect that succeeds when either delivery path succeeds, or fails with `SubagentCompletionDeliveryFailed` when both paths fail.
 */
export const notifySubagentFinished: (
	options: NotifySubagentFinishedOptions,
) => Effect.Effect<void, SubagentCompletionDeliveryFailed> = Effect.fnUntraced(function* (options) {
	const completion: SubagentFinishedPayload = {
		name: options.name,
		status: options.status,
		finalMessage: options.finalMessage.slice(0, MAX_FINAL_MESSAGE_WIRE_CHARS),
		sentAtMs: options.sentAtMs,
		completionId: options.completionId ?? randomUUID(),
		armId: options.armId,
	};
	const socketLayer = Layer.effect(
		Socket.Socket,
		NodeSocket.makeNet({ path: options.socketPath, openTimeout: RPC_OPEN_TIMEOUT }),
	);
	const send = Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(SubagentRpcs);
			// Await the server's ack before the scoped socket is torn down. Discarding
			// the response and hanging up immediately made the server's ack write hit a
			// closed connection, logging an EPIPE SocketError on every notification.
			yield* client.SubagentFinished(completion);
		}).pipe(
			Effect.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: false })),
			Effect.provide(socketLayer),
			Effect.provide(RpcSerialization.layerNdjson),
		),
	).pipe(
		Effect.timeout(RPC_TIMEOUT),
		Effect.as(true),
		Effect.catchCause(() => Effect.succeed(false)),
	);

	// Persist before opening the best-effort socket. A failed or interrupted RPC remains
	// available to the parent's watcher through the shared runtime directory.
	const persisted = yield* persistCompletion(completion);
	const delivered = yield* send;
	if (delivered) {
		yield* removePersistedCompletion(completion);
		return;
	}
	if (!persisted) {
		return yield* new SubagentCompletionDeliveryFailed({
			message: `Could not deliver or persist the settled result for subagent ${completion.name}`,
			name: completion.name,
			socketPath: options.socketPath,
		});
	}
});
