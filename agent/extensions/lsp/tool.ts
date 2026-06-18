import { readFile, writeFile } from "node:fs/promises";
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
import { Effect } from "effect";
import type { Diagnostic } from "vscode-languageserver-types";

import {
	LspBinaryMissing,
	LspInitializeError,
	LspMalformedResponse,
	LspNoClients,
	LspPermissionDenied,
	LspSpawnError,
	LspUnsupportedOperation,
} from "./errors";
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
	"rename",
	"codeAction",
	"formatting",
	"organizeImports",
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
	newName?: string;
	actionTitle?: string;
	codeActionKind?: string;
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
	newName: Type.Optional(Type.String({ description: "New symbol name for rename." })),
	actionTitle: Type.Optional(Type.String({ description: "Exact code action title to apply." })),
	codeActionKind: Type.Optional(Type.String({ description: "Code action kind filter." })),
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
		if (resolution.unavailable.length === 1) {
			const unavailable = resolution.unavailable[0];
			if (unavailable !== undefined) {
				if (unavailable.reason.includes("Spawn permission is")) {
					throw LspPermissionDenied.make({
						serverId: unavailable.serverId,
						reason: unavailable.reason,
					});
				}
				if (unavailable.reason.includes("server binary found")) {
					throw LspBinaryMissing.make({
						serverId: unavailable.serverId,
						reason: unavailable.reason,
					});
				}
				if (unavailable.reason.includes("initialize")) {
					throw LspInitializeError.make({
						serverId: unavailable.serverId,
						reason: unavailable.reason,
					});
				}
				if (unavailable.reason.includes("Failed to start")) {
					throw LspSpawnError.make({
						serverId: unavailable.serverId,
						reason: unavailable.reason,
					});
				}
			}
		}
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

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

interface TextEditLike {
	range: LspRange;
	newText: string;
}

interface CodeActionLike {
	title: string;
	kind?: string;
	edit?: unknown;
	command?: unknown;
}

const isPosition = (value: unknown): value is LspPosition =>
	isRecord(value) && typeof value.line === "number" && typeof value.character === "number";

const isRange = (value: unknown): value is LspRange =>
	isRecord(value) && isPosition(value.start) && isPosition(value.end);

const isTextEdit = (value: unknown): value is TextEditLike =>
	isRecord(value) && isRange(value.range) && typeof value.newText === "string";

const isCodeAction = (value: unknown): value is CodeActionLike =>
	isRecord(value) && typeof value.title === "string";

const endPosition = (text: string): LspPosition => {
	const lines = text.split(/\r\n|\r|\n/);
	return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

const offsetAt = (text: string, position: LspPosition): number => {
	let offset = 0;
	let line = 0;
	while (line < position.line && offset < text.length) {
		const next = text.indexOf("\n", offset);
		if (next === -1) return text.length;
		offset = next + 1;
		line += 1;
	}
	return Math.min(text.length, offset + Math.max(0, position.character));
};

const applyTextEdits = (
	operation: LspOperation,
	text: string,
	edits: ReadonlyArray<TextEditLike>,
): string => {
	const ranges = edits.map((edit) => ({
		edit,
		start: offsetAt(text, edit.range.start),
		end: offsetAt(text, edit.range.end),
	}));
	ranges.sort((left, right) => right.start - left.start);
	let result = text;
	let previousStart = text.length + 1;
	for (const item of ranges) {
		if (item.start > item.end || item.end > previousStart) {
			throw LspMalformedResponse.make({
				operation,
				reason: `${operation} returned overlapping edits`,
			});
		}
		result = `${result.slice(0, item.start)}${item.edit.newText}${result.slice(item.end)}`;
		previousStart = item.start;
	}
	return result;
};

const workspaceEditEntries = (
	operation: LspOperation,
	edit: unknown,
): ReadonlyArray<readonly [string, ReadonlyArray<TextEditLike>]> => {
	if (!isRecord(edit)) {
		throw LspMalformedResponse.make({
			operation,
			reason: `${operation} returned no workspace edit`,
		});
	}
	const entries: Array<readonly [string, ReadonlyArray<TextEditLike>]> = [];
	if (isRecord(edit.changes)) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			if (!Array.isArray(edits) || !edits.every(isTextEdit)) {
				throw LspMalformedResponse.make({
					operation,
					reason: `${operation} returned malformed edits`,
				});
			}
			entries.push([uri, edits]);
		}
	}
	if (Array.isArray(edit.documentChanges)) {
		for (const change of edit.documentChanges) {
			if (
				!isRecord(change) ||
				!isRecord(change.textDocument) ||
				typeof change.textDocument.uri !== "string"
			) {
				throw LspMalformedResponse.make({
					operation,
					reason: `${operation} returned unsupported document changes`,
				});
			}
			if (!Array.isArray(change.edits) || !change.edits.every(isTextEdit)) {
				throw LspMalformedResponse.make({
					operation,
					reason: `${operation} returned malformed document changes`,
				});
			}
			entries.push([change.textDocument.uri, change.edits]);
		}
	}
	return entries;
};

const applyWorkspaceEdit = async (
	operation: LspOperation,
	cwd: string,
	edit: unknown,
): Promise<ReadonlyArray<string>> => {
	const changedFiles: string[] = [];
	for (const [uri, edits] of workspaceEditEntries(operation, edit)) {
		const file = uriToPath(uri);
		if (file === undefined) {
			throw LspMalformedResponse.make({
				operation,
				reason: `${operation} returned non-file edit URI`,
			});
		}
		const text = await readFile(file, "utf8");
		const next = applyTextEdits(operation, text, edits);
		if (next !== text) {
			await writeFile(file, next, "utf8");
			changedFiles.push(formatPath(cwd, file));
		}
	}
	return changedFiles;
};

const mutationApproval = async (
	ctx: ExtensionContext,
	title: string,
	body: string,
): Promise<void> => {
	if (!ctx.hasUI) throw new Error(`${title} requires interactive approval.`);
	const approved = await ctx.ui.confirm(title, body);
	if (!approved) throw new Error(`${title} was declined.`);
};

const formatApplied = (label: string, files: ReadonlyArray<string>): string =>
	files.length === 0
		? `${label}: no edits returned.`
		: `${label} to:\n${files.map((file) => `- ${file}`).join("\n")}`;

const fullDocumentRange = async (file: string): Promise<LspRange> => ({
	start: { line: 0, character: 0 },
	end: endPosition(await readFile(file, "utf8")),
});

const codeActionRequestParams = async (
	file: string,
	kind?: string,
): Promise<Record<string, unknown>> => ({
	textDocument: { uri: pathToFileURL(file).href },
	range: await fullDocumentRange(file),
	context: { diagnostics: [], ...(kind ? { only: [kind] } : {}) },
});

const firstMutationClient = (
	operation: LspOperation,
	clients: ReadonlyArray<LocatedClient>,
): LocatedClient => {
	const client = clients[0];
	if (client === undefined) {
		throw LspUnsupportedOperation.make({
			operation,
			reason: `No ${operation} client available.`,
		});
	}
	return client;
};

export const registerLspTool = (pi: ExtensionAPI, getRuntime: () => LspRuntime | undefined) => {
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Interact with Language Server Protocol servers for code intelligence and approved edits: definitions, references, hover/type info, symbols, call hierarchy, diagnostics, rename, code actions, formatting, and organize imports. Lines and characters are 1-based; characters are UTF-16 offsets. Output is truncated to pi's standard limits.",
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
						Effect.runPromise(
							client.requestEffect<unknown[]>(
								method,
								requestParamsForOperation(params.operation, file, position),
							),
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
						const items = await Effect.runPromise(
							client.requestEffect<unknown[]>("textDocument/prepareCallHierarchy", {
								textDocument: { uri },
								position,
							}),
						);
						const item = items[0];
						if (item === undefined) return [];
						return await Effect.runPromise(
							client.requestEffect<unknown[]>(methodForOperation(params.operation), { item }),
						);
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
							Effect.runPromise(
								client.requestEffect("textDocument/hover", {
									textDocument: { uri: file },
									position: { line: line - 1, character: character - 1 },
								}),
							),
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
						Effect.runPromise(
							client.requestEffect<unknown[]>("textDocument/documentSymbol", {
								textDocument: { uri: pathToFileURL(absolute).href },
							}),
						),
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
						Effect.runPromise(
							client.requestEffect<unknown[]>("workspace/symbol", { query: params.query ?? "" }),
						),
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
				case "rename": {
					const { filePath, line, character } = requirePosition(params);
					if (!params.newName) throw new Error("rename requires newName");
					const { client } = firstMutationClient(
						"rename",
						requireOperationSupport(
							"rename",
							await ensureClients(runtime, params, ctx, "navigation"),
						),
					);
					serverIds = [client.serverId];
					const file = absolutePath(ctx.cwd, filePath);
					const edit = await Effect.runPromise(
						client.requestEffect("textDocument/rename", {
							textDocument: { uri: pathToFileURL(file).href },
							position: { line: line - 1, character: character - 1 },
							newName: params.newName,
						}),
					);
					await mutationApproval(ctx, "Apply LSP rename?", `Apply rename to ${params.newName}?`);
					const files = await applyWorkspaceEdit("rename", ctx.cwd, edit);
					await Promise.all(files.map((file) => runtime.touchRunningFile(file)));
					results = { files };
					text = formatApplied("Applied rename", files);
					break;
				}
				case "formatting": {
					const filePath = requireFile(params);
					const { client } = firstMutationClient(
						"formatting",
						requireOperationSupport(
							"formatting",
							await ensureClients(runtime, params, ctx, "navigation"),
						),
					);
					serverIds = [client.serverId];
					const file = absolutePath(ctx.cwd, filePath);
					const uri = pathToFileURL(file).href;
					const edits = await Effect.runPromise(
						client.requestEffect("textDocument/formatting", {
							textDocument: { uri },
							options: { tabSize: 2, insertSpaces: false },
						}),
					);
					await mutationApproval(ctx, "Apply LSP formatting?", `Apply formatting to ${filePath}?`);
					const files = await applyWorkspaceEdit("formatting", ctx.cwd, {
						changes: { [uri]: edits },
					});
					await Promise.all(files.map((file) => runtime.touchRunningFile(file)));
					results = { files };
					text = formatApplied("Applied formatting", files);
					break;
				}
				case "codeAction": {
					const filePath = requireFile(params);
					const { client } = firstMutationClient(
						"codeAction",
						requireOperationSupport(
							"codeAction",
							await ensureClients(runtime, params, ctx, "navigation"),
						),
					);
					serverIds = [client.serverId];
					const file = absolutePath(ctx.cwd, filePath);
					const actions = (
						await Effect.runPromise(
							client.requestEffect<unknown[]>(
								"textDocument/codeAction",
								await codeActionRequestParams(file, params.codeActionKind),
							),
						)
					).filter(isCodeAction);
					if (!params.actionTitle) {
						results = actions.map((action) => ({ title: action.title, kind: action.kind }));
						text =
							actions.length === 0
								? "No code actions found."
								: `Code actions:\n${actions.map((action) => `- ${action.title}${action.kind ? ` [${action.kind}]` : ""}`).join("\n")}`;
						break;
					}
					const action = actions.find((item) => item.title === params.actionTitle);
					if (action === undefined) throw new Error(`No code action titled ${params.actionTitle}`);
					if (action.edit === undefined) {
						throw LspUnsupportedOperation.make({
							operation: "codeAction",
							reason: "Code actions without workspace edits are not supported.",
						});
					}
					await mutationApproval(
						ctx,
						"Apply LSP code action?",
						`Apply code action ${action.title}?`,
					);
					const files = await applyWorkspaceEdit("codeAction", ctx.cwd, action.edit);
					await Promise.all(files.map((file) => runtime.touchRunningFile(file)));
					results = { action: action.title, files };
					text = formatApplied("Applied code action", files);
					break;
				}
				case "organizeImports": {
					const filePath = requireFile(params);
					const { client } = firstMutationClient(
						"organizeImports",
						requireOperationSupport(
							"organizeImports",
							await ensureClients(runtime, params, ctx, "navigation"),
						),
					);
					serverIds = [client.serverId];
					const file = absolutePath(ctx.cwd, filePath);
					const actions = (
						await Effect.runPromise(
							client.requestEffect<unknown[]>(
								"textDocument/codeAction",
								await codeActionRequestParams(file, "source.organizeImports"),
							),
						)
					).filter(isCodeAction);
					const action = actions.find((item) => item.edit !== undefined);
					if (action === undefined || action.edit === undefined) {
						throw LspUnsupportedOperation.make({
							operation: "organizeImports",
							reason: "No organize imports edit was returned.",
						});
					}
					await mutationApproval(
						ctx,
						"Apply LSP organize imports?",
						`Apply organize imports to ${filePath}?`,
					);
					const files = await applyWorkspaceEdit("organizeImports", ctx.cwd, action.edit);
					await Promise.all(files.map((file) => runtime.touchRunningFile(file)));
					results = { action: action.title, files };
					text = formatApplied("Applied organize imports", files);
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
