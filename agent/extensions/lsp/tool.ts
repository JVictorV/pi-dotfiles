import { relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Diagnostic } from "vscode-languageserver-types";

import { LspMalformedResponse, LspNoClients, LspUnsupportedOperation } from "./errors";
import type { LspRuntime, LocatedClient } from "./runtime";

const OPERATIONS = [
	"definition",
	"references",
	"hover",
	"documentSymbol",
	"workspaceSymbol",
	"implementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	"diagnostics",
	"status",
] as const;

type LspOperation = (typeof OPERATIONS)[number];

interface LspParams {
	operation: LspOperation;
	filePath?: string;
	line?: number;
	character?: number;
	query?: string;
	limit?: number;
}

interface NormalizedLocation {
	file: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
	label?: string;
}

interface NormalizedDiagnostic {
	file: string;
	line: number;
	character: number;
	severity: string;
	message: string;
	source?: string;
}

interface NormalizedSymbol {
	name: string;
	file?: string;
	line?: number;
	character?: number;
	children?: ReadonlyArray<NormalizedSymbol>;
}

interface LspDetails {
	operation: LspOperation;
	serverIds: ReadonlyArray<string>;
	results?: unknown;
	truncated: boolean;
}

const paramsSchema = Type.Object({
	operation: StringEnum(OPERATIONS),
	filePath: Type.Optional(
		Type.String({ description: "Path to the file. Required for file/position operations." }),
	),
	line: Type.Optional(Type.Number({ description: "1-based line number as shown in editors." })),
	character: Type.Optional(
		Type.Number({ description: "1-based UTF-16 character offset as shown in editors." }),
	),
	query: Type.Optional(Type.String({ description: "Workspace symbol query." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
});

const textContent = (text: string): TextContent => ({ type: "text", text });

const requireFile = (params: LspParams): string => {
	if (!params.filePath) throw new Error(`${params.operation} requires filePath`);
	return params.filePath;
};

const requirePosition = (
	params: LspParams,
): { filePath: string; line: number; character: number } => {
	const filePath = requireFile(params);
	if (params.line === undefined || params.line < 1)
		throw new Error(`${params.operation} requires line >= 1`);
	if (params.character === undefined || params.character < 1) {
		throw new Error(`${params.operation} requires character >= 1`);
	}
	return { filePath, line: Math.floor(params.line), character: Math.floor(params.character) };
};

const limitFor = (params: LspParams, fallback: number): number => {
	if (params.limit === undefined || !Number.isFinite(params.limit)) return fallback;
	return Math.max(1, Math.min(1000, Math.floor(params.limit)));
};

const uriToPath = (uri: unknown): string | undefined => {
	if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
	return fileURLToPath(uri);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeLocation = (value: unknown): NormalizedLocation | undefined => {
	if (!isRecord(value)) return undefined;

	const locationUri = uriToPath(value.uri);
	if (locationUri !== undefined && isRecord(value.selectionRange)) {
		const location = locationFromRange(locationUri, value.selectionRange);
		if (location !== undefined) location.label = symbolName(value);
		return location;
	}
	if (locationUri !== undefined && isRecord(value.range)) {
		const location = locationFromRange(locationUri, value.range);
		if (location !== undefined) location.label = symbolName(value);
		return location;
	}

	const targetUri = uriToPath(value.targetUri);
	if (targetUri !== undefined && isRecord(value.targetSelectionRange)) {
		return locationFromRange(targetUri, value.targetSelectionRange);
	}

	return undefined;
};

const locationFromRange = (
	file: string,
	range: Record<string, unknown>,
): NormalizedLocation | undefined => {
	if (!isRecord(range.start)) return undefined;
	const line = range.start.line;
	const character = range.start.character;
	if (typeof line !== "number" || typeof character !== "number") return undefined;
	const location: NormalizedLocation = { file, line: line + 1, character: character + 1 };
	if (
		isRecord(range.end) &&
		typeof range.end.line === "number" &&
		typeof range.end.character === "number"
	) {
		location.endLine = range.end.line + 1;
		location.endCharacter = range.end.character + 1;
	}
	return location;
};

const responseItems = (value: unknown): ReadonlyArray<unknown> =>
	Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];

const normalizeLocations = (value: unknown): ReadonlyArray<NormalizedLocation> =>
	responseItems(value)
		.map(normalizeLocation)
		.filter((location): location is NormalizedLocation => location !== undefined);

const requireNormalizedLocations = (
	operation: LspOperation,
	value: unknown,
): ReadonlyArray<NormalizedLocation> => {
	const values = responseItems(value);
	const locations = normalizeLocations(values);
	if (locations.length !== values.length) {
		throw LspMalformedResponse.make({
			operation,
			reason: `${operation} returned malformed locations`,
		});
	}
	return locations;
};

const formatPath = (cwd: string, file: string): string => {
	const rel = relative(cwd, file);
	return rel && !rel.startsWith("..") ? rel : file;
};

const formatLocation = (cwd: string, location: NormalizedLocation): string => {
	const label = location.label ? ` ${location.label}` : "";
	return `${formatPath(cwd, location.file)}:${location.line}:${location.character}${label}`;
};

const formatLocationList = (
	cwd: string,
	title: string,
	locations: ReadonlyArray<NormalizedLocation>,
	limit: number,
): string => {
	if (locations.length === 0) return `No ${title} results found.`;
	const shown = locations.slice(0, limit);
	const suffix =
		locations.length > shown.length
			? `\n... ${locations.length - shown.length} more omitted by limit.`
			: "";
	return `${title}:\n${shown.map((location) => `- ${formatLocation(cwd, location)}`).join("\n")}${suffix}`;
};

const hoverToText = (value: unknown): string => {
	if (!isRecord(value)) return "No hover results found.";
	const contents = value.contents;
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverPartToText).filter(Boolean).join("\n\n");
	return hoverPartToText(contents) || "No hover results found.";
};

const hoverPartToText = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	if (typeof value.value === "string" && typeof value.language === "string") {
		return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
	}
	if (typeof value.value === "string") return value.value;
	return "";
};

const symbolName = (value: unknown): string | undefined =>
	isRecord(value) && typeof value.name === "string" ? value.name : undefined;

const normalizeDocumentSymbols = (value: unknown, filePath: string): NormalizedSymbol[] => {
	if (!Array.isArray(value)) return [];
	const symbols: NormalizedSymbol[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const name = symbolName(item);
		if (name === undefined) continue;
		const loc = isRecord(item.selectionRange)
			? locationFromRange(filePath, item.selectionRange)
			: undefined;
		const children = normalizeDocumentSymbols(item.children, filePath);
		const symbol: NormalizedSymbol = { name };
		if (loc !== undefined) {
			symbol.file = loc.file;
			symbol.line = loc.line;
			symbol.character = loc.character;
		}
		if (children.length > 0) symbol.children = children;
		symbols.push(symbol);
	}
	return symbols;
};

const flattenDocumentSymbols = (
	value: unknown,
	cwd: string,
	filePath: string,
	prefix = "",
): string[] => {
	if (!Array.isArray(value)) return [];
	const lines: string[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const name = symbolName(item);
		if (name === undefined) continue;
		const loc = isRecord(item.selectionRange)
			? locationFromRange(filePath, item.selectionRange)
			: undefined;
		lines.push(`- ${prefix}${name}${loc ? ` ${formatLocation(cwd, loc)}` : ""}`);
		lines.push(...flattenDocumentSymbols(item.children, cwd, filePath, `${prefix}${name}.`));
	}
	return lines;
};

const callHierarchyToLocations = (
	operation: LspOperation,
	value: unknown,
): ReadonlyArray<NormalizedLocation> => {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (!isRecord(item)) return undefined;
			const target =
				operation === "incomingCalls" ? item.from : operation === "outgoingCalls" ? item.to : item;
			return normalizeLocation(target);
		})
		.filter((location): location is NormalizedLocation => location !== undefined);
};

const workspaceSymbolsToLocations = (value: unknown): ReadonlyArray<NormalizedLocation> => {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (!isRecord(item) || !isRecord(item.location)) return undefined;
			const location = normalizeLocation(item.location);
			if (location === undefined) return undefined;
			location.label = symbolName(item);
			return location;
		})
		.filter((location): location is NormalizedLocation => location !== undefined);
};

const diagnosticSeverity = (severity: unknown): string => {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "diagnostic";
	}
};

const diagnosticMessageToText = (message: Diagnostic["message"]): string =>
	typeof message === "string" ? message : message.value;

const normalizeDiagnostics = (
	diagnosticsByFile: ReadonlyMap<string, ReadonlyArray<Diagnostic>>,
): NormalizedDiagnostic[] => {
	const normalized: NormalizedDiagnostic[] = [];
	for (const [file, diagnostics] of diagnosticsByFile.entries()) {
		for (const diagnostic of diagnostics) {
			const item: NormalizedDiagnostic = {
				file,
				line: diagnostic.range.start.line + 1,
				character: diagnostic.range.start.character + 1,
				severity: diagnosticSeverity(diagnostic.severity),
				message: diagnosticMessageToText(diagnostic.message),
			};
			if (diagnostic.source !== undefined) item.source = diagnostic.source;
			normalized.push(item);
		}
	}
	return normalized;
};

const formatDiagnostics = (
	cwd: string,
	diagnosticsByFile: ReadonlyMap<string, ReadonlyArray<Diagnostic>>,
	limit: number,
): string => {
	const lines: string[] = [];
	for (const [file, diagnostics] of diagnosticsByFile.entries()) {
		for (const diagnostic of diagnostics) {
			const line = diagnostic.range.start.line + 1;
			const character = diagnostic.range.start.character + 1;
			lines.push(
				`- ${formatPath(cwd, file)}:${line}:${character} [${diagnosticSeverity(diagnostic.severity)}] ${diagnosticMessageToText(diagnostic.message)}`,
			);
		}
	}
	if (lines.length === 0) return "No diagnostics found.";
	const shown = lines.slice(0, limit);
	const suffix =
		lines.length > shown.length
			? `\n... ${lines.length - shown.length} more diagnostics omitted by limit.`
			: "";
	return `Diagnostics:\n${shown.join("\n")}${suffix}`;
};

const truncateText = (text: string): { text: string; truncated: boolean } => {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: truncation.content, truncated: false };
	return {
		text: `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`,
		truncated: true,
	};
};

const ensureClients = async (
	runtime: LspRuntime,
	params: LspParams,
	ctx: ExtensionContext,
	capability: "navigation" | "diagnostics",
): Promise<ReadonlyArray<LocatedClient>> => {
	const filePath = requireFile(params);
	const resolution = await runtime.clientsForFile(filePath, capability, ctx, {
		prompt: true,
		waitForDiagnostics: capability === "diagnostics",
	});
	if (resolution.clients.length === 0) {
		const reasons = resolution.unavailable
			.map((item) => `- ${item.serverId}: ${item.reason}`)
			.join("\n");
		throw LspNoClients.make({
			reason: reasons
				? `No LSP clients available.\n${reasons}`
				: "No LSP clients available for this file.",
		});
	}
	return resolution.clients;
};

const requireOperationSupport = (
	operation: LspOperation,
	clients: ReadonlyArray<LocatedClient>,
): ReadonlyArray<LocatedClient> => {
	const supported = clients.filter(({ client }) => client.supportsOperation(operation));
	if (supported.length === 0) {
		throw LspUnsupportedOperation.make({
			operation,
			reason: `${operation} is not supported by available LSP clients.`,
		});
	}
	return supported;
};

const runAcrossClients = async <T>(
	clients: ReadonlyArray<LocatedClient>,
	fn: (client: LocatedClient) => Promise<T>,
) => (await Promise.all(clients.map(fn))).flat();

const absolutePath = (cwd: string, filePath: string): string =>
	resolve(cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);

export const registerLspTool = (pi: ExtensionAPI, getRuntime: () => LspRuntime | undefined) => {
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Interact with Language Server Protocol servers for read-only code intelligence: definitions, references, hover/type info, symbols, call hierarchy, status, and diagnostics. Lines and characters are 1-based; characters are UTF-16 offsets. Output is truncated to pi's standard limits.",
		promptSnippet:
			"Query language servers for semantic code navigation, symbols, hover/type info, call hierarchy, and diagnostics",
		promptGuidelines: [
			"Use lsp for symbol-aware navigation, definitions, references, hover/type information, document symbols, workspace symbols, call hierarchy, and diagnostics.",
			"Prefer lsp over grep when looking for semantic relationships such as where a symbol is defined or referenced.",
		],
		parameters: paramsSchema,
		async execute(_toolCallId, params: LspParams, _signal, _onUpdate, ctx) {
			const runtime = getRuntime();
			if (runtime === undefined) throw new Error("LSP runtime is not initialized.");

			let text: string;
			let results: unknown;
			let serverIds: ReadonlyArray<string> = [];

			switch (params.operation) {
				case "status": {
					const statuses = runtime.status();
					results = statuses;
					text =
						statuses.length === 0
							? `No LSP clients running. Available servers: ${runtime.serverIds().join(", ")}`
							: `LSP clients:\n${statuses.map((status) => `- ${status.serverId} ${status.status} root=${status.displayRoot}`).join("\n")}`;
					break;
				}
				case "definition":
				case "references":
				case "implementation":
				case "prepareCallHierarchy": {
					const { filePath, line, character } = requirePosition(params);
					const clients = requireOperationSupport(
						params.operation,
						await ensureClients(runtime, params, ctx, "navigation"),
					);
					serverIds = clients.map(({ client }) => client.serverId);
					const file = pathToFileURL(absolutePath(ctx.cwd, filePath)).href;
					const position = { line: line - 1, character: character - 1 };
					const method = methodForOperation(params.operation);
					const raw = await runAcrossClients(clients, ({ client }) =>
						client.request<unknown[]>(
							method,
							requestParamsForOperation(params.operation, file, position),
						),
					);
					const locations = requireNormalizedLocations(params.operation, raw);
					results = locations;
					text = formatLocationList(ctx.cwd, params.operation, locations, limitFor(params, 100));
					break;
				}
				case "incomingCalls":
				case "outgoingCalls": {
					const { filePath, line, character } = requirePosition(params);
					const clients = requireOperationSupport(
						params.operation,
						await ensureClients(runtime, params, ctx, "navigation"),
					);
					serverIds = clients.map(({ client }) => client.serverId);
					const uri = pathToFileURL(absolutePath(ctx.cwd, filePath)).href;
					const position = { line: line - 1, character: character - 1 };
					const raw = await runAcrossClients(clients, async ({ client }) => {
						const items = await client.request<unknown[]>("textDocument/prepareCallHierarchy", {
							textDocument: { uri },
							position,
						});
						const item = items[0];
						if (item === undefined) return [];
						return await client.request<unknown[]>(methodForOperation(params.operation), { item });
					});
					const locations = callHierarchyToLocations(params.operation, raw);
					results = locations;
					text = formatLocationList(ctx.cwd, params.operation, locations, limitFor(params, 100));
					break;
				}
				case "hover": {
					const { filePath, line, character } = requirePosition(params);
					const clients = requireOperationSupport(
						params.operation,
						await ensureClients(runtime, params, ctx, "navigation"),
					);
					serverIds = clients.map(({ client }) => client.serverId);
					const file = pathToFileURL(absolutePath(ctx.cwd, filePath)).href;
					const raw = await Promise.all(
						clients.map(({ client }) =>
							client.request("textDocument/hover", {
								textDocument: { uri: file },
								position: { line: line - 1, character: character - 1 },
							}),
						),
					);
					const hovers = raw.map(hoverToText).filter(Boolean);
					results = hovers;
					text = hovers.join("\n\n---\n\n") || "No hover results found.";
					break;
				}
				case "documentSymbol": {
					const filePath = requireFile(params);
					const clients = requireOperationSupport(
						params.operation,
						await ensureClients(runtime, params, ctx, "navigation"),
					);
					serverIds = clients.map(({ client }) => client.serverId);
					const absolute = absolutePath(ctx.cwd, filePath);
					const raw = await runAcrossClients(clients, ({ client }) =>
						client.request<unknown[]>("textDocument/documentSymbol", {
							textDocument: { uri: pathToFileURL(absolute).href },
						}),
					);
					results = normalizeDocumentSymbols(raw, absolute);
					const lines = flattenDocumentSymbols(raw, ctx.cwd, absolute).slice(
						0,
						limitFor(params, 200),
					);
					text =
						lines.length === 0
							? "No document symbols found."
							: `Document symbols:\n${lines.join("\n")}`;
					break;
				}
				case "workspaceSymbol": {
					const clients = requireOperationSupport(
						params.operation,
						params.filePath
							? await ensureClients(runtime, params, ctx, "navigation")
							: runtime.runningClients("navigation"),
					);
					if (clients.length === 0)
						throw new Error("No running LSP clients. Pass filePath to start a matching server.");
					serverIds = clients.map(({ client }) => client.serverId);
					const raw = await runAcrossClients(clients, ({ client }) =>
						client.request<unknown[]>("workspace/symbol", { query: params.query ?? "" }),
					);
					const locations = workspaceSymbolsToLocations(raw);
					results = locations;
					text = formatLocationList(ctx.cwd, "Workspace symbols", locations, limitFor(params, 50));
					break;
				}
				case "diagnostics": {
					if (params.filePath) {
						const clients = await ensureClients(runtime, params, ctx, "diagnostics");
						serverIds = clients.map(({ client }) => client.serverId);
					}
					const diagnostics = runtime.diagnostics(params.filePath);
					results = normalizeDiagnostics(diagnostics);
					text = formatDiagnostics(ctx.cwd, diagnostics, limitFor(params, 200));
					break;
				}
			}

			const truncated = truncateText(text);
			const details: LspDetails = {
				operation: params.operation,
				serverIds,
				results,
				truncated: truncated.truncated,
			};
			return { content: [textContent(truncated.text)], details };
		},
	});
};

const methodForOperation = (operation: LspOperation): string => {
	switch (operation) {
		case "definition":
			return "textDocument/definition";
		case "references":
			return "textDocument/references";
		case "implementation":
			return "textDocument/implementation";
		case "prepareCallHierarchy":
			return "textDocument/prepareCallHierarchy";
		case "incomingCalls":
			return "callHierarchy/incomingCalls";
		case "outgoingCalls":
			return "callHierarchy/outgoingCalls";
		default:
			throw new Error(`${operation} does not map to a location method`);
	}
};

const requestParamsForOperation = (
	operation: LspOperation,
	uri: string,
	position: { line: number; character: number },
): unknown => {
	if (operation === "references") {
		return { textDocument: { uri }, position, context: { includeDeclaration: true } };
	}
	return { textDocument: { uri }, position };
};
