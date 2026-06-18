import { readFile } from "node:fs/promises";

import { configPath } from "./paths";
import type { LspConfig, ServerCapabilities, UserServerConfig } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	throw new Error(`agent/lsp.json field ${field} must be a boolean`);
};

const optionalStringArray = (value: unknown, field: string): ReadonlyArray<string> | undefined => {
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw new Error(`agent/lsp.json field ${field} must be an array of strings`);
};

const optionalStringRecord = (
	value: unknown,
	field: string,
): Readonly<Record<string, string>> | undefined => {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`agent/lsp.json field ${field} must be an object of string values`);
	}

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw new Error(`agent/lsp.json field ${field}.${key} must be a string`);
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
		throw new Error(`agent/lsp.json field ${field} must be an object`);
	}
	return {
		navigation: optionalBoolean(value.navigation, `${field}.navigation`),
		diagnostics: optionalBoolean(value.diagnostics, `${field}.diagnostics`),
	};
};

const parseServerConfig = (serverId: string, value: unknown): UserServerConfig => {
	if (!isRecord(value)) {
		throw new Error(`agent/lsp.json server ${serverId} must be an object`);
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
		throw new Error("agent/lsp.json must contain a JSON object");
	}

	if (value.servers === undefined) {
		return { servers: {} };
	}

	if (!isRecord(value.servers)) {
		throw new Error("agent/lsp.json field servers must be an object");
	}

	const servers: Record<string, UserServerConfig> = {};
	for (const [serverId, server] of Object.entries(value.servers)) {
		servers[serverId] = parseServerConfig(serverId, server);
	}
	return { servers };
};

export const loadLspConfig = async (): Promise<LspConfig> => {
	const path = configPath();
	const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});

	if (text === undefined) {
		return { servers: {} };
	}

	return parseConfig(JSON.parse(text));
};
