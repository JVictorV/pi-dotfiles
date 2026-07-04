import { Effect, Fiber, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";

import { ActionRejected, failAction, HerdrCommandFailed } from "./errors";
import {
	decodeAgentGetResponse,
	decodeJsonString,
	decodePaneCurrentResponse,
	decodeTabGetResponse,
} from "./schemas";
import type { HerdrAgent, HerdrPane } from "./schemas";
import type { CommandSuccess } from "./types";

export const HERDR_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;

export const isRunningInsideHerdr = (): boolean => globalThis.process?.env["HERDR_ENV"] === "1";

type HerdrProcessRequirements = ChildProcessSpawner | FileSystem | Path;

type HerdrExitOutcome =
	| { readonly timedOut: false; readonly code: number | null }
	| { readonly timedOut: true };

const herdrExited = (code: number | null): HerdrExitOutcome => ({ timedOut: false, code });

const herdrTimedOut: HerdrExitOutcome = { timedOut: true };

const runHerdrProcess: (
	args: ReadonlyArray<string>,
	output: { stdout: string; stderr: string },
	timeoutMs: number,
) => Effect.Effect<CommandSuccess, HerdrCommandFailed, HerdrProcessRequirements> =
	Effect.fnUntraced(function* (args, output, timeoutMs) {
		const command = ChildProcess.make("herdr", [...args], {
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
					Effect.mapError(
						() =>
							new HerdrCommandFailed({
								message: "Failed to start herdr. Is the herdr CLI installed and on PATH?",
								stdout: output.stdout,
								stderr: output.stderr,
								code: null,
								timedOut: false,
							}),
					),
				);

				const stdoutFiber = yield* handle.stdout.pipe(
					Stream.runForEach((chunk) =>
						Effect.sync(() => {
							output.stdout += Buffer.from(chunk).toString("utf8");
						}),
					),
					Effect.catch(() => Effect.void),
					Effect.forkScoped,
				);
				const stderrFiber = yield* handle.stderr.pipe(
					Stream.runForEach((chunk) =>
						Effect.sync(() => {
							output.stderr += Buffer.from(chunk).toString("utf8");
						}),
					),
					Effect.catch(() => Effect.void),
					Effect.forkScoped,
				);

				const waitForOutput = Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
					discard: true,
				});
				const waitForCode = handle.exitCode.pipe(
					Effect.map((code) => Number(code)),
					Effect.catch(() => Effect.succeed<number | null>(null)),
				);
				const exitFiber = yield* waitForCode.pipe(Effect.forkScoped);
				const outcome = yield* Fiber.join(exitFiber)
					.pipe(Effect.map((code) => herdrExited(code)))
					.pipe(Effect.raceFirst(Effect.sleep(timeoutMs).pipe(Effect.as(herdrTimedOut))));
				if (outcome.timedOut) {
					yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: KILL_GRACE_MS }).pipe(
						Effect.catch(() => Effect.void),
						Effect.forkScoped,
					);
					yield* Effect.sleep(KILL_GRACE_MS);
					const running = yield* handle.isRunning.pipe(Effect.catch(() => Effect.succeed(true)));
					if (running) {
						yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.catch(() => Effect.void));
					}
					const code = yield* Fiber.join(exitFiber);
					yield* waitForOutput;
					return yield* new HerdrCommandFailed({
						message: `herdr timed out after ${timeoutMs}ms`,
						stdout: output.stdout,
						stderr: output.stderr,
						code,
						timedOut: true,
					});
				}

				const code = outcome.code;
				yield* waitForOutput;
				if (code === 0) {
					return { stdout: output.stdout, stderr: output.stderr };
				}
				return yield* new HerdrCommandFailed({
					message: `herdr exited with code ${code ?? "unknown"}`,
					stdout: output.stdout,
					stderr: output.stderr,
					code,
					timedOut: false,
				});
			}),
		);
	});

export const runHerdr = (
	args: ReadonlyArray<string>,
	timeoutMs = HERDR_TIMEOUT_MS,
): Effect.Effect<CommandSuccess, HerdrCommandFailed, HerdrProcessRequirements> =>
	Effect.suspend(() => {
		const output = { stdout: "", stderr: "" };
		return runHerdrProcess(args, output, timeoutMs);
	});

const formatSchemaFailure = (error: unknown): string => {
	if (Schema.isSchemaError(error)) {
		return error.issue.toString();
	}
	return "unexpected non-schema decode failure";
};

export const decodeHerdrJson: <A>(
	args: ReadonlyArray<string>,
	decode: (input: unknown) => Effect.Effect<A, unknown>,
	timeoutMs?: number,
) => Effect.Effect<A, HerdrCommandFailed, HerdrProcessRequirements> = Effect.fnUntraced(function* <
	A,
>(
	args: ReadonlyArray<string>,
	decode: (input: unknown) => Effect.Effect<A, unknown>,
	timeoutMs = HERDR_TIMEOUT_MS,
) {
	const outcome = yield* runHerdr(args, timeoutMs);
	const json = yield* decodeJsonString(outcome.stdout).pipe(
		Effect.catch(() =>
			Effect.fail(
				new HerdrCommandFailed({
					message: "herdr returned non-JSON output",
					stdout: outcome.stdout,
					stderr: outcome.stderr,
					code: 0,
					timedOut: false,
				}),
			),
		),
	);
	return yield* decode(json).pipe(
		Effect.catch((error) => {
			const details = formatSchemaFailure(error);
			return Effect.fail(
				new HerdrCommandFailed({
					message: "herdr returned unexpected JSON shape",
					stdout: outcome.stdout,
					stderr: [outcome.stderr, details].filter((part) => part.trim().length > 0).join("\n"),
					code: 0,
					timedOut: false,
				}),
			);
		}),
	);
});

export const currentPane = (): Effect.Effect<
	HerdrPane,
	HerdrCommandFailed | ActionRejected,
	HerdrProcessRequirements
> =>
	decodeHerdrJson(["pane", "current", "--current"], decodePaneCurrentResponse).pipe(
		Effect.flatMap((response) => {
			const pane = response.result.pane;
			if (!pane) {
				return failAction("Could not find current pane in herdr response");
			}
			return Effect.succeed(pane);
		}),
	);

export const liveAgent = (
	target: string,
): Effect.Effect<HerdrAgent | undefined, never, HerdrProcessRequirements> =>
	decodeHerdrJson(["agent", "get", target], decodeAgentGetResponse).pipe(
		Effect.map((response) => response.result.agent),
		Effect.catch(() => Effect.succeed(undefined)),
	);

export const tabExists = (tabId: string): Effect.Effect<boolean, never, HerdrProcessRequirements> =>
	decodeHerdrJson(["tab", "get", tabId], decodeTabGetResponse).pipe(
		Effect.map(() => true),
		Effect.catch(() => Effect.succeed(false)),
	);
