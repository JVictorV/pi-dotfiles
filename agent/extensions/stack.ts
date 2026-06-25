import { spawn } from "node:child_process";

import { StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	isToolCallEventType,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_STREAM_BYTES = 1024 * 1024;

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
	signal: NodeJS.Signals | null;
	killed: boolean;
	timedOut: boolean;
}

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

const clampTimeoutSeconds = (timeout: number | undefined): number => {
	if (timeout === undefined || !Number.isFinite(timeout)) {
		return DEFAULT_TIMEOUT_SECONDS;
	}

	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, timeout));
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

const runStack = Effect.fn("runStack")(function* (
	cwd: string,
	params: StackParams,
	timeoutSeconds: number,
	agentSignal: AbortSignal | undefined,
) {
	return yield* Effect.callback<StackProcessResult, StackToolError>((resume, effectSignal) => {
		let stdout: CapturedStream = { text: "", bytes: 0, truncated: false };
		let stderr: CapturedStream = { text: "", bytes: 0, truncated: false };
		let settled = false;

		const child = spawn("stack", [params.command, ...(params.args ?? [])], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const cleanup = (): void => {
			agentSignal?.removeEventListener("abort", abortHandler);
			effectSignal.removeEventListener("abort", abortHandler);
		};

		const finish = (result: StackProcessResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resume(Effect.succeed(result));
		};

		const fail = (reason: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resume(Effect.fail(stackToolError(reason)));
		};

		const stopChild = (): void => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
		};

		const abortHandler = (): void => {
			stopChild();
		};

		if (agentSignal?.aborted || effectSignal.aborted) {
			abortHandler();
		} else {
			agentSignal?.addEventListener("abort", abortHandler, { once: true });
			effectSignal.addEventListener("abort", abortHandler, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = captureChunk(stdout, chunk);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = captureChunk(stderr, chunk);
		});

		child.on("error", () => {
			fail("Failed to start stack. Install it with: npm install -g @kitlangton/stack");
		});

		child.on("close", (code, closeSignal) => {
			finish({
				stdout,
				stderr,
				code,
				signal: closeSignal,
				killed: child.killed || closeSignal !== null,
				timedOut: false,
			});
		});

		return Effect.sync(() => {
			cleanup();
			stopChild();
		});
	}).pipe(
		Effect.timeoutOrElse({
			duration: `${timeoutSeconds} seconds`,
			orElse: () =>
				Effect.succeed({
					stdout: { text: "", bytes: 0, truncated: false },
					stderr: { text: "", bytes: 0, truncated: false },
					code: 124,
					signal: null,
					killed: true,
					timedOut: true,
				}),
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
			return await Effect.runPromise(executeStack(ctx.cwd, params, signal));
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
