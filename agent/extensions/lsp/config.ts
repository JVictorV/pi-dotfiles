import { readFile } from "node:fs/promises";

import { Effect } from "effect";

import { LspConfigError } from "./errors";
import { configPath } from "./paths";
import type { LspConfig, ServerCapabilities, UserServerConfig } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	throw LspConfigError.make({ reason: `agent/lsp.json field ${field} must be a boolean` });
};

const optionalStringArray = (value: unknown, field: string): ReadonlyArray<string> | undefined => {
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw LspConfigError.make({
		reason: `agent/lsp.json field ${field} must be an array of strings`,
	});
};

const optionalStringRecord = (
	value: unknown,
	field: string,
): Readonly<Record<string, string>> | undefined => {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw LspConfigError.make({
			reason: `agent/lsp.json field ${field} must be an object of string values`,
		});
	}

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw LspConfigError.make({
				reason: `agent/lsp.json field ${field}.${key} must be a string`,
			});
		}
		result[key] = item;
	}
	return result;
};

const optionalCapabilities = (
	value: unknown,
	field: string,
): Partial<ServerCapabilities> | undefined => {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw LspConfigError.make({ reason: `agent/lsp.json field ${field} must be an object` });
	}
	return {
		navigation: optionalBoolean(value.navigation, `${field}.navigation`),
		diagnostics: optionalBoolean(value.diagnostics, `${field}.diagnostics`),
	};
};

const parseServerConfig = (serverId: string, value: unknown): UserServerConfig => {
	if (!isRecord(value)) {
		throw LspConfigError.make({ reason: `agent/lsp.json server ${serverId} must be an object` });
	}

	return {
		disabled: optionalBoolean(value.disabled, `servers.${serverId}.disabled`),
		command: optionalStringArray(value.command, `servers.${serverId}.command`),
		env: optionalStringRecord(value.env, `servers.${serverId}.env`),
		extensions: optionalStringArray(value.extensions, `servers.${serverId}.extensions`),
		rootMarkers: optionalStringArray(value.rootMarkers, `servers.${serverId}.rootMarkers`),
		strictRoot: optionalBoolean(value.strictRoot, `servers.${serverId}.strictRoot`),
		capabilities: optionalCapabilities(value.capabilities, `servers.${serverId}.capabilities`),
	};
};

const parseConfig = (value: unknown): LspConfig => {
	if (!isRecord(value)) {
		throw LspConfigError.make({ reason: "agent/lsp.json must contain a JSON object" });
	}

	if (value.servers === undefined) {
		return { servers: {} };
	}

	if (!isRecord(value.servers)) {
		throw LspConfigError.make({ reason: "agent/lsp.json field servers must be an object" });
	}

	const servers: Record<string, UserServerConfig> = {};
	for (const [serverId, server] of Object.entries(value.servers)) {
		servers[serverId] = parseServerConfig(serverId, server);
	}
	return { servers };
};

export const loadLspConfig = (): Effect.Effect<LspConfig, unknown> =>
	Effect.gen(function* () {
		const path = configPath();
		const text = yield* Effect.tryPromise({
			try: () => readFile(path, "utf8"),
			catch: (error) => error as NodeJS.ErrnoException,
		}).pipe(
			Effect.catch((error) => {
				if (error.code === "ENOENT") return Effect.succeed(undefined);
				return Effect.fail(error);
			}),
		);

		if (text === undefined) return { servers: {} };

		return yield* Effect.try({
			try: () => parseConfig(JSON.parse(text)),
			catch: (error) => {
				if (error instanceof LspConfigError) return error;
				const reason = error instanceof Error ? error.message : String(error);
				return LspConfigError.make({ reason });
			},
		});
	});
