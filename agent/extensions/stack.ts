import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	isToolCallEventType,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_STREAM_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

type StackPlatformRequirements = ChildProcessSpawner | FileSystem | Path;

const nodeLayer = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);
// ExtensionAPI exposes session lifecycle hooks but no extension unload/reload teardown; this
// stateless Node layer only allocates per-run Scope resources, so a /reload orphan is GC-reclaimable.
const nodeRuntime = ManagedRuntime.make(nodeLayer);

type StackCommand =
	| "status"
	| "guide"
	| "track"
	| "sync"
	| "doctor"
	| "merge"
	| "repair"
	| "history"
	| "undo";

const STACK_COMMANDS: ReadonlyArray<StackCommand> = [
	"status",
	"guide",
	"track",
	"sync",
	"doctor",
	"merge",
	"repair",
	"history",
	"undo",
];

interface StackParams {
	command: StackCommand;
	args?: ReadonlyArray<string>;
	timeout?: number;
}

interface CapturedStream {
	text: string;
	bytes: number;
	truncated: boolean;
}

interface StackProcessResult {
	stdout: CapturedStream;
	stderr: CapturedStream;
	code: number | null;
	signal: string | null;
	killed: boolean;
	timedOut: boolean;
}

interface StackExitStatus {
	readonly code: number | null;
	readonly signal: string | null;
}

type StackWaitOutcome =
	| { readonly timedOut: false; readonly exit: StackExitStatus }
	| { readonly timedOut: true; readonly result: StackProcessResult };

interface StackDetails {
	command: string;
	args: ReadonlyArray<string>;
	exitCode: number;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outputTruncated: boolean;
	killed: boolean;
	timedOut: boolean;
}

class StackToolError extends Schema.TaggedErrorClass<StackToolError>()("StackToolError", {
	message: Schema.String,
	reason: Schema.String,
}) {}

const stackToolError = (reason: string): StackToolError =>
	StackToolError.make({ message: reason, reason });
const textContent = (text: string): TextContent => ({ type: "text", text });
const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessageOption = Schema.decodeUnknownOption(ErrorMessage);
// Matches the exact message NodeChildProcessSpawner puts on the exitCode PlatformError for
// signal-terminated processes; the signal is not exposed as a structured field, and the
// dependency is pinned to 4.0.0-beta.90. A non-match degrades to signal-less reporting.
const EXIT_SIGNAL_PATTERN = /Process interrupted due to receipt of signal: '([^']+)'/;

const clampTimeoutSeconds = (timeout: number | undefined): number => {
	if (timeout === undefined || !Number.isFinite(timeout)) {
		return DEFAULT_TIMEOUT_SECONDS;
	}

	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, timeout));
};

const exitSignalFromError = (error: unknown): string | null => {
	const message = decodeErrorMessageOption(error);
	if (Option.isNone(message)) return null;
	return EXIT_SIGNAL_PATTERN.exec(message.value.message)?.[1] ?? null;
};

const captureChunk = (stream: CapturedStream, chunk: Buffer): CapturedStream => {
	if (stream.bytes >= MAX_STREAM_BYTES) {
		return { ...stream, bytes: stream.bytes + chunk.byteLength, truncated: true };
	}

	const remaining = MAX_STREAM_BYTES - stream.bytes;
	const kept = chunk.subarray(0, remaining);
	return {
		text: stream.text + kept.toString("utf8"),
		bytes: stream.bytes + chunk.byteLength,
		truncated: stream.truncated || chunk.byteLength > remaining,
	};
};

const runStack: (
	cwd: string,
	params: StackParams,
	timeoutSeconds: number,
	agentSignal: AbortSignal | undefined,
) => Effect.Effect<StackProcessResult, StackToolError, StackPlatformRequirements> = Effect.fn(
	"runStack",
)(function* (cwd, params, timeoutSeconds, agentSignal) {
	let stdout: CapturedStream = { text: "", bytes: 0, truncated: false };
	let stderr: CapturedStream = { text: "", bytes: 0, truncated: false };
	const command = ChildProcess.make("stack", [params.command, ...(params.args ?? [])], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: false,
		killSignal: "SIGTERM",
		forceKillAfter: KILL_GRACE_MS,
	});

	return yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* command.pipe(
				Effect.mapError(() =>
					stackToolError(
						"Failed to start stack. Install it with: npm install -g @kitlangton/stack",
					),
				),
			);

			if (agentSignal?.aborted) {
				yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: KILL_GRACE_MS }).pipe(
					Effect.catch(() => Effect.void),
					Effect.forkScoped,
				);
			}

			const stdoutFiber = yield* handle.stdout.pipe(
				Stream.runForEach((chunk) =>
					Effect.sync(() => {
						stdout = captureChunk(stdout, Buffer.from(chunk));
					}),
				),
				Effect.catch(() => Effect.void),
				Effect.forkScoped,
			);
			const stderrFiber = yield* handle.stderr.pipe(
				Stream.runForEach((chunk) =>
					Effect.sync(() => {
						stderr = captureChunk(stderr, Buffer.from(chunk));
					}),
				),
				Effect.catch(() => Effect.void),
				Effect.forkScoped,
			);
			const waitForOutput = Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
				discard: true,
			});
			const waitForExit = handle.exitCode.pipe(
				Effect.map((code): StackExitStatus => ({ code: Number(code), signal: null })),
				Effect.catch((error) =>
					Effect.succeed<StackExitStatus>({ code: null, signal: exitSignalFromError(error) }),
				),
			);
			const timedOutResult = Effect.gen(function* () {
				yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: KILL_GRACE_MS }).pipe(
					Effect.catch(() => Effect.void),
					Effect.forkScoped,
				);
				yield* Effect.sleep(KILL_GRACE_MS);
				const running = yield* handle.isRunning.pipe(Effect.catch(() => Effect.succeed(true)));
				if (running) {
					yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.catch(() => Effect.void));
				}
				return {
					stdout: { text: "", bytes: 0, truncated: false },
					stderr: { text: "", bytes: 0, truncated: false },
					code: 124,
					signal: null,
					killed: true,
					timedOut: true,
				};
			});
			const outcome = yield* waitForExit.pipe(
				Effect.map((exit): StackWaitOutcome => ({ timedOut: false, exit })),
				Effect.timeoutOrElse({
					duration: `${timeoutSeconds} seconds`,
					orElse: () =>
						timedOutResult.pipe(
							Effect.map((result): StackWaitOutcome => ({ timedOut: true, result })),
						),
				}),
			);
			if (outcome.timedOut) {
				return outcome.result;
			}
			yield* waitForOutput;
			return {
				stdout,
				stderr,
				code: outcome.exit.code,
				signal: outcome.exit.signal,
				killed: outcome.exit.code === null || outcome.exit.signal !== null,
				timedOut: false,
			};
		}),
	);
});

const formatProcessFailure = (result: StackProcessResult): string => {
	const status = result.timedOut
		? "timed out"
		: result.signal
			? `terminated by ${result.signal}`
			: `exited with code ${result.code ?? "unknown"}`;
	const output = [result.stdout.text, result.stderr.text].filter((text) => text.trim()).join("\n");
	return output.trim().length > 0 ? `stack ${status}:\n${output.trim()}` : `stack ${status}`;
};

const formatOutput = (result: StackProcessResult): { text: string; truncated: boolean } => {
	const combined = [result.stdout.text, result.stderr.text]
		.filter((text) => text.trim().length > 0)
		.join("\n");
	const output = combined.length > 0 ? combined : "stack command completed successfully";
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const suffix = truncation.truncated
		? `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
		: "";

	return { text: `${truncation.content}${suffix}`, truncated: truncation.truncated };
};

const executeStack = Effect.fn("executeStack")(function* (
	cwd: string,
	params: StackParams,
	signal: AbortSignal | undefined,
) {
	const timeoutSeconds = clampTimeoutSeconds(params.timeout);
	const result = yield* runStack(cwd, params, timeoutSeconds, signal);

	if (result.code !== 0 || result.timedOut) {
		return yield* Effect.fail(stackToolError(formatProcessFailure(result)));
	}

	const output = formatOutput(result);
	const details: StackDetails = {
		command: params.command,
		args: params.args ?? [],
		exitCode: result.code ?? -1,
		stdoutBytes: result.stdout.bytes,
		stderrBytes: result.stderr.bytes,
		stdoutTruncated: result.stdout.truncated,
		stderrTruncated: result.stderr.truncated,
		outputTruncated: output.truncated,
		killed: result.killed,
		timedOut: result.timedOut,
	};

	return {
		content: [textContent(output.text)],
		details,
	};
});

const GITHUB_STACK_PATTERN = /(^|[;&|\s])gh\s+stack\b/;

export default function stackExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "stack",
		label: "Stack",
		description:
			"Run the local @kitlangton/stack CLI for squash-safe stacked PR workflows. Use for stack status, guide, track, sync, doctor, merge, repair, history, and undo. Output is truncated to 2000 lines or 50KB.",
		promptSnippet:
			"Use the local stack CLI for squash-safe stacked PR inspection, sync, merge, repair, and undo",
		promptGuidelines: [
			"Use the stack tool whenever working with stacked PRs in squash-merge repositories.",
			"Prefer stack over GitHub's gh stack command for stacked PR repair workflows.",
			"Run stack guide when you need the recommended stacked PR workflow.",
			"Run stack status or stack sync --dry-run before mutating stack state.",
			"For the common workflow, run stack sync --dry-run before stack sync.",
			"Run stack merge as a dry-run before stack merge --apply or stack merge --auto.",
			"Do not edit .git/stack/state.json by hand; use stack track, stack sync, or stack undo instead.",
		],
		parameters: Type.Object({
			command: StringEnum([...STACK_COMMANDS], {
				description:
					"stack subcommand to run: status, guide, track, sync, doctor, merge, repair, history, or undo.",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Arguments after the subcommand, for example ['--dry-run'], ['branch', '--onto', 'parent'], or ['--auto', '--through', 'feature-c'].",
				}),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Optional timeout in seconds, clamped between 1 and 900." }),
			),
		}),
		async execute(_toolCallId, params: StackParams, signal, _onUpdate, ctx) {
			return await nodeRuntime.runPromise(executeStack(ctx.cwd, params, signal), { signal });
		},
	});

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) {
			return undefined;
		}

		if (GITHUB_STACK_PATTERN.test(event.input.command)) {
			return {
				block: true,
				reason:
					"Use the stack tool / local @kitlangton/stack CLI instead of gh stack for squash-safe stacked PR repair workflows.",
			};
		}

		return undefined;
	});
}
