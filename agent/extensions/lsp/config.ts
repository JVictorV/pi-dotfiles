import { readFile } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";

import { LspConfigError, lspErrorReason } from "./errors";
import { configPath } from "./paths";
import type { UserServerConfig } from "./types";
const failConfig = (reason: string): Effect.Effect<never, LspConfigError> =>
	Effect.fail(LspConfigError.make({ reason }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const NotFoundError = Schema.Struct({ code: Schema.Literal("ENOENT") });
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeNotFoundError = Schema.decodeUnknownOption(NotFoundError);

const isNotFoundError = (error: unknown): boolean => Option.isSome(decodeNotFoundError(error));

const optionalBoolean = (
	value: unknown,
	field: string,
): Effect.Effect<boolean | undefined, LspConfigError> => {
	if (value === undefined) return Effect.succeed(undefined);
	if (typeof value === "boolean") return Effect.succeed(value);
	return failConfig(`agent/lsp.json field ${field} must be a boolean`);
};

const optionalStringArray = (
	value: unknown,
	field: string,
): Effect.Effect<ReadonlyArray<string> | undefined, LspConfigError> => {
	if (value === undefined) return Effect.succeed(undefined);
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return Effect.succeed(value);
	}
	return failConfig(`agent/lsp.json field ${field} must be an array of strings`);
};

const optionalStringRecord = Effect.fn("optionalStringRecord")(function* (
	value: unknown,
	field: string,
) {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		return yield* failConfig(`agent/lsp.json field ${field} must be an object of string values`);
	}

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			return yield* failConfig(`agent/lsp.json field ${field}.${key} must be a string`);
		}
		result[key] = item;
	}
	return result;
});

const optionalCapabilities = Effect.fn("optionalCapabilities")(function* (
	value: unknown,
	field: string,
) {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		return yield* failConfig(`agent/lsp.json field ${field} must be an object`);
	}
	return {
		navigation: yield* optionalBoolean(value.navigation, `${field}.navigation`),
		diagnostics: yield* optionalBoolean(value.diagnostics, `${field}.diagnostics`),
	};
});

const parseServerConfig = Effect.fn("parseServerConfig")(function* (
	serverId: string,
	value: unknown,
) {
	if (!isRecord(value)) {
		return yield* failConfig(`agent/lsp.json server ${serverId} must be an object`);
	}

	return {
		disabled: yield* optionalBoolean(value.disabled, `servers.${serverId}.disabled`),
		command: yield* optionalStringArray(value.command, `servers.${serverId}.command`),
		env: yield* optionalStringRecord(value.env, `servers.${serverId}.env`),
		extensions: yield* optionalStringArray(value.extensions, `servers.${serverId}.extensions`),
		rootMarkers: yield* optionalStringArray(value.rootMarkers, `servers.${serverId}.rootMarkers`),
		strictRoot: yield* optionalBoolean(value.strictRoot, `servers.${serverId}.strictRoot`),
		capabilities: yield* optionalCapabilities(
			value.capabilities,
			`servers.${serverId}.capabilities`,
		),
	};
});

const parseConfig = Effect.fn("parseConfig")(function* (value: unknown) {
	if (!isRecord(value)) {
		return yield* failConfig("agent/lsp.json must contain a JSON object");
	}

	if (value.servers === undefined) {
		return { servers: {} };
	}

	if (!isRecord(value.servers)) {
		return yield* failConfig("agent/lsp.json field servers must be an object");
	}

	const servers: Record<string, UserServerConfig> = {};
	for (const [serverId, server] of Object.entries(value.servers)) {
		servers[serverId] = yield* parseServerConfig(serverId, server);
	}
	return { servers };
});

const parseJson = (text: string): Effect.Effect<unknown, LspConfigError> =>
	decodeUnknownJson(text).pipe(
		Effect.mapError(() =>
			LspConfigError.make({ reason: "agent/lsp.json must contain valid JSON" }),
		),
	);

const missingConfigReason = "agent/lsp.json not found";

export const loadLspConfig = Effect.fn("loadLspConfig")(function* () {
	const path = configPath();
	const text = yield* Effect.tryPromise({
		try: () => readFile(path, "utf8"),
		catch: (error) =>
			LspConfigError.make({
				reason: isNotFoundError(error)
					? missingConfigReason
					: lspErrorReason(error, "failed to read agent/lsp.json"),
			}),
	}).pipe(
		Effect.catchTag("LspConfigError", (error) =>
			error.reason === missingConfigReason ? Effect.succeed(undefined) : Effect.fail(error),
		),
	);

	if (text === undefined) return { servers: {} };

	const json = yield* parseJson(text);
	return yield* parseConfig(json);
});
