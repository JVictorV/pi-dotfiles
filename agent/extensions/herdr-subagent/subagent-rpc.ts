import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import { getRuntimeDir, safeFilePart } from "./runtime-files";

const RPC_TIMEOUT = "250 millis";
const RPC_DIRECTORY_MODE = 0o700;
const RPC_SOCKET_MODE = 0o600;
const STALE_SOCKET_MS = 60 * 60 * 1_000;
const MAX_FINAL_MESSAGE_WIRE_CHARS = 256_000;

const SubagentFinished = Rpc.make("SubagentFinished", {
	payload: {
		name: Schema.String,
		status: Schema.Literals(["done", "blocked"]),
		finalMessage: Schema.String.check(Schema.isMaxLength(MAX_FINAL_MESSAGE_WIRE_CHARS)),
		sentAtMs: Schema.Number,
	},
	success: Schema.String,
});

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

const mapStartFailure = (socketPath: string, cause: unknown): SubagentRpcServerStartFailed =>
	new SubagentRpcServerStartFailed({
		message: `Could not start herdr subagent RPC server at ${socketPath}`,
		socketPath,
		cause,
	});

const sweepStaleSockets = async (directory: string): Promise<void> => {
	const now = Date.now();
	const entries = await readdir(directory, { withFileTypes: true });
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isSocket() && !entry.isFile()) {
				return;
			}
			if (!entry.name.startsWith("v1-") || !entry.name.endsWith(".sock")) {
				return;
			}
			const filePath = path.join(directory, entry.name);
			const info = await stat(filePath);
			if (now - info.mtimeMs > STALE_SOCKET_MS) {
				await rm(filePath, { force: true });
			}
		}),
	);
};

const ensureSocketDirectory = (
	socketPath: string,
): Effect.Effect<void, SubagentRpcServerStartFailed> =>
	Effect.tryPromise({
		try: async () => {
			const directory = path.dirname(socketPath);
			await mkdir(directory, { recursive: true, mode: RPC_DIRECTORY_MODE });
			await chmod(directory, RPC_DIRECTORY_MODE);
			await sweepStaleSockets(directory);
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
	);
};

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
 * Best-effort client push from a subagent pi session to its orchestrator.
 *
 * This helper never fails at its boundary: missing sockets, dead orchestrators,
 * serialization failures, and mid-send socket defects are ignored so subagent
 * completion is not affected by the optional side channel.
 *
 * @param options - Socket path and subagent completion payload.
 */
export const notifySubagentFinished = (
	options: NotifySubagentFinishedOptions,
): Effect.Effect<void, never> => {
	const socketLayer = Layer.effect(
		Socket.Socket,
		NodeSocket.makeNet({ path: options.socketPath, openTimeout: RPC_TIMEOUT }),
	);
	return Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(SubagentRpcs);
			// `discard: true` still writes the request before the scoped socket is torn down;
			// the surrounding scope is the flush boundary for this fire-and-forget handoff.
			yield* client.SubagentFinished(
				{
					name: options.name,
					status: options.status,
					finalMessage: options.finalMessage.slice(0, MAX_FINAL_MESSAGE_WIRE_CHARS),
					sentAtMs: options.sentAtMs,
				},
				{ discard: true },
			);
		}).pipe(
			Effect.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: false })),
			Effect.provide(socketLayer),
			Effect.provide(RpcSerialization.layerNdjson),
		),
	).pipe(Effect.timeout(RPC_TIMEOUT), Effect.ignoreCause);
};
