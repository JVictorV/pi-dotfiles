import { Option, Schema } from "effect";

const ErrorReason = Schema.Struct({ reason: Schema.String });
const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorReasonOption = Schema.decodeUnknownOption(ErrorReason);
const decodeErrorMessageOption = Schema.decodeUnknownOption(ErrorMessage);

export const lspErrorReason = (error: unknown, fallback: string): string => {
	if (typeof error === "string" && error.length > 0) return error;
	const reason = decodeErrorReasonOption(error);
	if (Option.isSome(reason) && reason.value.reason.length > 0) return reason.value.reason;
	const message = decodeErrorMessageOption(error);
	if (Option.isSome(message) && message.value.message.length > 0) return message.value.message;
	return fallback;
};

// Every LSP error overrides `message` to return its `reason`. The agent harness
// builds a failed tool's `tool_result` content from `error.message`, and a
// `Schema.TaggedErrorClass` defaults to an empty `message`. An empty error
// `tool_result` is rejected by the Anthropic API ("content cannot be empty if
// is_error is true"), so each error must carry a non-empty, diagnosable message.

export class LspConfigError extends Schema.TaggedErrorClass<LspConfigError>()("LspConfigError", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export class LspPermissionFileError extends Schema.TaggedErrorClass<LspPermissionFileError>()(
	"LspPermissionFileError",
	{
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspPermissionDenied extends Schema.TaggedErrorClass<LspPermissionDenied>()(
	"LspPermissionDenied",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspBinaryMissing extends Schema.TaggedErrorClass<LspBinaryMissing>()(
	"LspBinaryMissing",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspSpawnError extends Schema.TaggedErrorClass<LspSpawnError>()("LspSpawnError", {
	serverId: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export class LspInitializeError extends Schema.TaggedErrorClass<LspInitializeError>()(
	"LspInitializeError",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspRequestTimeout extends Schema.TaggedErrorClass<LspRequestTimeout>()(
	"LspRequestTimeout",
	{
		serverId: Schema.String,
		method: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspRequestError extends Schema.TaggedErrorClass<LspRequestError>()("LspRequestError", {
	serverId: Schema.String,
	method: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export class LspClientBroken extends Schema.TaggedErrorClass<LspClientBroken>()("LspClientBroken", {
	serverId: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export class LspNoClients extends Schema.TaggedErrorClass<LspNoClients>()("LspNoClients", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export class LspToolInputError extends Schema.TaggedErrorClass<LspToolInputError>()(
	"LspToolInputError",
	{
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspUnsupportedOperation extends Schema.TaggedErrorClass<LspUnsupportedOperation>()(
	"LspUnsupportedOperation",
	{
		operation: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspMalformedResponse extends Schema.TaggedErrorClass<LspMalformedResponse>()(
	"LspMalformedResponse",
	{
		operation: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspShutdownError extends Schema.TaggedErrorClass<LspShutdownError>()(
	"LspShutdownError",
	{
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspRuntimeShuttingDown extends Schema.TaggedErrorClass<LspRuntimeShuttingDown>()(
	"LspRuntimeShuttingDown",
	{
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspFilesystemError extends Schema.TaggedErrorClass<LspFilesystemError>()(
	"LspFilesystemError",
	{
		operation: Schema.String,
		path: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return this.reason;
	}
}

export class LspRuntimeError extends Schema.TaggedErrorClass<LspRuntimeError>()("LspRuntimeError", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export type LspError =
	| LspConfigError
	| LspPermissionFileError
	| LspPermissionDenied
	| LspBinaryMissing
	| LspSpawnError
	| LspInitializeError
	| LspRequestTimeout
	| LspRequestError
	| LspClientBroken
	| LspNoClients
	| LspToolInputError
	| LspUnsupportedOperation
	| LspMalformedResponse
	| LspShutdownError
	| LspRuntimeShuttingDown
	| LspFilesystemError
	| LspRuntimeError;

export const lspRuntimeShuttingDown = (): LspRuntimeShuttingDown =>
	LspRuntimeShuttingDown.make({ reason: "LSP runtime is shutting down." });
