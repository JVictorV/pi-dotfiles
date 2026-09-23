import type { HerdrConfigurationError, HerdrTransportRequestError } from "@herdr/sdk";
import { Effect, Predicate, Schema } from "effect";

import { truncateForModel } from "./output";
import { casesHandled } from "./prelude";
import type { WorktreeIsolationFailed } from "./worktree";

/** Expected failure of a herdr_subagent action, rejected at the tool boundary. */
export class HerdrSubagentToolError extends Schema.TaggedError<HerdrSubagentToolError>()(
	"HerdrSubagentToolError",
	{ message: Schema.String },
) {}

/** The current process is not running inside herdr. */
export class HerdrNotAvailable extends Schema.TaggedError<HerdrNotAvailable>()(
	"HerdrNotAvailable",
	{
		message: Schema.String,
	},
) {}

/** A tool action was rejected before or between herdr calls. */
export class ActionRejected extends Schema.TaggedError<ActionRejected>()("ActionRejected", {
	message: Schema.String,
}) {}

/** A spawned subagent attempted to recursively orchestrate subagents without an explicit grant. */
export class SubagentRecursionDenied extends Schema.TaggedError<SubagentRecursionDenied>()(
	"SubagentRecursionDenied",
	{
		message: Schema.String,
		action: Schema.Literals(["spawn", "send", "close", "focus"]),
	},
) {}

/** A requested spawn model could not be resolved to an available pi model. */
export class ModelResolutionFailed extends Schema.TaggedError<ModelResolutionFailed>()(
	"ModelResolutionFailed",
	{
		message: Schema.String,
		input: Schema.String,
		availableModels: Schema.Array(Schema.String),
	},
) {}

/** A target name, terminal id, or pane id could not be resolved. */
export class TargetNotResolved extends Schema.TaggedError<TargetNotResolved>()(
	"TargetNotResolved",
	{
		message: Schema.String,
	},
) {}

/** Waiting for a subagent did not reach the requested terminal condition. */
export class WaitTimedOut extends Schema.TaggedError<WaitTimedOut>()("WaitTimedOut", {
	message: Schema.String,
}) {}

/** A runtime file or registry write failed. */
export class HerdrFileSystemFailed extends Schema.TaggedError<HerdrFileSystemFailed>()(
	"HerdrFileSystemFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Project-local agent approval could not be collected. */
export class SpawnRejected extends Schema.TaggedError<SpawnRejected>()("SpawnRejected", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export type HerdrSubagentError =
	| HerdrNotAvailable
	| HerdrTransportRequestError
	| HerdrConfigurationError
	| ActionRejected
	| SubagentRecursionDenied
	| ModelResolutionFailed
	| TargetNotResolved
	| WaitTimedOut
	| HerdrFileSystemFailed
	| SpawnRejected
	| WorktreeIsolationFailed;

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
		case "HerdrConfigurationError":
		case "HerdrInvalidInput":
		case "HerdrTransportError":
		case "HerdrRequestTimeout":
		case "HerdrInvalidResponse":
		case "HerdrUnsupportedProtocol":
		case "HerdrUnsupportedResult":
		case "HerdrServerError":
			return new HerdrSubagentToolError({
				message: truncateForModel(`[${failure._tag}] ${failure.message}`).text,
			});
		case "HerdrNotAvailable":
		case "ActionRejected":
		case "SubagentRecursionDenied":
		case "ModelResolutionFailed":
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
