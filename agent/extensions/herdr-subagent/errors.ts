import { Effect, Predicate, Schema } from "effect";

import { truncateForModel } from "./output";
import { casesHandled } from "./prelude";
import type { WorktreeIsolationFailed } from "./worktree";

/** Expected failure of a herdr_subagent action, rejected at the tool boundary. */
export class HerdrSubagentToolError extends Schema.TaggedErrorClass<HerdrSubagentToolError>()(
	"HerdrSubagentToolError",
	{ message: Schema.String },
) {}

/** The current process is not running inside herdr. */
export class HerdrNotAvailable extends Schema.TaggedErrorClass<HerdrNotAvailable>()(
	"HerdrNotAvailable",
	{
		message: Schema.String,
	},
) {}

/** A herdr CLI invocation failed or returned unusable output. */
export class HerdrCommandFailed extends Schema.TaggedErrorClass<HerdrCommandFailed>()(
	"HerdrCommandFailed",
	{
		message: Schema.String,
		stdout: Schema.String,
		stderr: Schema.String,
		code: Schema.NullOr(Schema.Number),
		timedOut: Schema.Boolean,
	},
) {}

/** A tool action was rejected before or between herdr calls. */
export class ActionRejected extends Schema.TaggedErrorClass<ActionRejected>()("ActionRejected", {
	message: Schema.String,
}) {}

/** A spawned subagent attempted to recursively orchestrate subagents without an explicit grant. */
export class SubagentRecursionDenied extends Schema.TaggedErrorClass<SubagentRecursionDenied>()(
	"SubagentRecursionDenied",
	{
		message: Schema.String,
		action: Schema.Literals(["spawn", "send", "close", "focus"]),
	},
) {}

/** A target name, terminal id, or pane id could not be resolved. */
export class TargetNotResolved extends Schema.TaggedErrorClass<TargetNotResolved>()(
	"TargetNotResolved",
	{
		message: Schema.String,
	},
) {}

/** Waiting for a subagent did not reach the requested terminal condition. */
export class WaitTimedOut extends Schema.TaggedErrorClass<WaitTimedOut>()("WaitTimedOut", {
	message: Schema.String,
}) {}

/** A runtime file or registry write failed. */
export class HerdrFileSystemFailed extends Schema.TaggedErrorClass<HerdrFileSystemFailed>()(
	"HerdrFileSystemFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Project-local agent approval could not be collected. */
export class SpawnRejected extends Schema.TaggedErrorClass<SpawnRejected>()("SpawnRejected", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export type HerdrSubagentError =
	| HerdrNotAvailable
	| HerdrCommandFailed
	| ActionRejected
	| SubagentRecursionDenied
	| TargetNotResolved
	| WaitTimedOut
	| HerdrFileSystemFailed
	| SpawnRejected
	| WorktreeIsolationFailed;

export const commandFailureText = (failure: HerdrCommandFailed): string => {
	const output = [failure.stdout, failure.stderr]
		.filter((part) => part.trim().length > 0)
		.join("\n");
	const suffix = output.trim().length > 0 ? `\n${truncateForModel(output).text}` : "";
	return `${failure.message}${suffix}`;
};

const causeText = (cause: unknown): string => {
	if (Predicate.isError(cause)) {
		const message = Object.getOwnPropertyDescriptor(cause, "message")?.value;
		return typeof message === "string" ? message : "";
	}
	if (typeof cause === "string") {
		return cause;
	}
	if (typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint") {
		return `${cause}`;
	}
	if (cause === null) {
		return "null";
	}
	return typeof cause;
};

const messageWithCause = (message: string, cause: unknown): string =>
	`${message}\nCause: ${causeText(cause)}`;

export const toToolError = (failure: HerdrSubagentError): HerdrSubagentToolError => {
	switch (failure._tag) {
		case "HerdrCommandFailed":
			return new HerdrSubagentToolError({ message: commandFailureText(failure) });
		case "HerdrNotAvailable":
		case "ActionRejected":
		case "SubagentRecursionDenied":
		case "TargetNotResolved":
		case "WaitTimedOut":
			return new HerdrSubagentToolError({ message: failure.message });
		case "HerdrFileSystemFailed":
		case "SpawnRejected":
		case "WorktreeIsolationFailed":
			return new HerdrSubagentToolError({
				message: messageWithCause(failure.message, failure.cause),
			});
		default:
			return casesHandled(failure);
	}
};

export const failAction = (message: string): Effect.Effect<never, ActionRejected> =>
	Effect.fail(new ActionRejected({ message }));

export const failTarget = (message: string): Effect.Effect<never, TargetNotResolved> =>
	Effect.fail(new TargetNotResolved({ message }));

export const fsFailure = (
	operation: string,
	filePath: string,
	cause: unknown,
): HerdrFileSystemFailed =>
	new HerdrFileSystemFailed({
		message: `${operation} failed for ${filePath}`,
		cause,
	});
