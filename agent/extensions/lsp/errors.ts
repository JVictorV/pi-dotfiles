import { Schema } from "effect";

export class LspConfigError extends Schema.TaggedErrorClass<LspConfigError>()("LspConfigError", {
	reason: Schema.String,
}) {}

export class LspPermissionFileError extends Schema.TaggedErrorClass<LspPermissionFileError>()(
	"LspPermissionFileError",
	{
		reason: Schema.String,
	},
) {}

export class LspPermissionDenied extends Schema.TaggedErrorClass<LspPermissionDenied>()(
	"LspPermissionDenied",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspBinaryMissing extends Schema.TaggedErrorClass<LspBinaryMissing>()(
	"LspBinaryMissing",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspSpawnError extends Schema.TaggedErrorClass<LspSpawnError>()("LspSpawnError", {
	serverId: Schema.String,
	reason: Schema.String,
}) {}

export class LspInitializeError extends Schema.TaggedErrorClass<LspInitializeError>()(
	"LspInitializeError",
	{
		serverId: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspRequestTimeout extends Schema.TaggedErrorClass<LspRequestTimeout>()(
	"LspRequestTimeout",
	{
		serverId: Schema.String,
		method: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspRequestError extends Schema.TaggedErrorClass<LspRequestError>()("LspRequestError", {
	serverId: Schema.String,
	method: Schema.String,
	reason: Schema.String,
}) {}

export class LspClientBroken extends Schema.TaggedErrorClass<LspClientBroken>()("LspClientBroken", {
	serverId: Schema.String,
	reason: Schema.String,
}) {}

export class LspNoClients extends Schema.TaggedErrorClass<LspNoClients>()("LspNoClients", {
	reason: Schema.String,
}) {}

export class LspToolInputError extends Schema.TaggedErrorClass<LspToolInputError>()(
	"LspToolInputError",
	{
		reason: Schema.String,
	},
) {}

export class LspUnsupportedOperation extends Schema.TaggedErrorClass<LspUnsupportedOperation>()(
	"LspUnsupportedOperation",
	{
		operation: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspMalformedResponse extends Schema.TaggedErrorClass<LspMalformedResponse>()(
	"LspMalformedResponse",
	{
		operation: Schema.String,
		reason: Schema.String,
	},
) {}

export class LspShutdownError extends Schema.TaggedErrorClass<LspShutdownError>()(
	"LspShutdownError",
	{
		reason: Schema.String,
	},
) {}

export class LspRuntimeShuttingDown extends Schema.TaggedErrorClass<LspRuntimeShuttingDown>()(
	"LspRuntimeShuttingDown",
	{
		reason: Schema.String,
	},
) {}

export const lspRuntimeShuttingDown = (): LspRuntimeShuttingDown =>
	LspRuntimeShuttingDown.make({ reason: "LSP runtime is shutting down." });
