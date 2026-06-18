import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
	createMessageConnection,
	Emitter,
	StreamMessageReader,
	type Message,
	type MessageConnection,
	type MessageWriter,
} from "vscode-jsonrpc/node";
import { Effect } from "effect";
import type { Diagnostic } from "vscode-languageserver-types";

import { LspInitializeError, LspRequestError, LspRequestTimeout } from "./errors";
import type { LspServerHandle } from "./server";

const INITIALIZE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_WAIT_TIMEOUT_MS = 1_000;
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

interface ServerCapabilities {
	textDocumentSync?: unknown;
	diagnosticProvider?: unknown;
	hoverProvider?: unknown;
	definitionProvider?: unknown;
	referencesProvider?: unknown;
	documentSymbolProvider?: unknown;
	workspaceSymbolProvider?: unknown;
	implementationProvider?: unknown;
	callHierarchyProvider?: unknown;
	renameProvider?: unknown;
	codeActionProvider?: unknown;
	documentFormattingProvider?: unknown;
}

interface OpenDocument {
	version: number;
	text: string;
}

interface DocumentDiagnosticReport {
	items?: Diagnostic[];
	relatedDocuments?: Record<string, DocumentDiagnosticReport>;
}

interface WorkspaceDiagnosticReport {
	items?: Array<{ uri?: string; items?: Diagnostic[] }>;
}

interface DiagnosticRegistration {
	id: string;
	method: string;
	registerOptions?: {
		identifier?: string;
		workspaceDiagnostics?: boolean;
	};
}

export interface LspClientStatus {
	serverId: string;
	label: string;
	root: string;
	status: "connected" | "broken";
}

const withTimeout = async <T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> => {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
};

const getFilePath = (uri: string): string | undefined => {
	if (!uri.startsWith("file://")) return undefined;
	return fileURLToPath(uri);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const syncKind = (capabilities: ServerCapabilities): number | undefined => {
	const sync = capabilities.textDocumentSync;
	if (typeof sync === "number") return sync;
	if (isRecord(sync) && typeof sync.change === "number") return sync.change;
	return undefined;
};

const endPosition = (text: string): { line: number; character: number } => {
	const lines = text.split(/\r\n|\r|\n/);
	return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
	".astro": "astro",
	".bash": "shellscript",
	".bat": "bat",
	".bib": "bibtex",
	".c": "c",
	".cc": "cpp",
	".clj": "clojure",
	".cljs": "clojure",
	".cljc": "clojure",
	".cmake": "cmake",
	".cpp": "cpp",
	".cs": "csharp",
	".csh": "shellscript",
	".css": "css",
	".cts": "typescript",
	".dart": "dart",
	".dockerfile": "dockerfile",
	".ex": "elixir",
	".exs": "elixir",
	".fs": "fsharp",
	".fsi": "fsharp",
	".fsx": "fsharp",
	".gleam": "gleam",
	".go": "go",
	".h": "c",
	".hpp": "cpp",
	".hs": "haskell",
	".htm": "html",
	".html": "html",
	".java": "java",
	".jl": "julia",
	".js": "javascript",
	".json": "json",
	".jsonc": "jsonc",
	".jsx": "javascriptreact",
	".kt": "kotlin",
	".kts": "kotlin",
	".less": "less",
	".lhs": "haskell",
	".lua": "lua",
	".mjs": "javascript",
	".ml": "ocaml",
	".mli": "ocaml",
	".mts": "typescript",
	".nix": "nix",
	".php": "php",
	".prisma": "prisma",
	".ps1": "powershell",
	".py": "python",
	".pyi": "python",
	".r": "r",
	".rb": "ruby",
	".rs": "rust",
	".sass": "sass",
	".scala": "scala",
	".scss": "scss",
	".sh": "shellscript",
	".svelte": "svelte",
	".swift": "swift",
	".tf": "terraform",
	".tfvars": "terraform-vars",
	".ts": "typescript",
	".tsx": "typescriptreact",
	".typ": "typst",
	".vue": "vue",
	".yaml": "yaml",
	".yml": "yaml",
	".zig": "zig",
	".zon": "zig",
};

const languageIdForPath = (file: string): string => {
	const lower = file.toLowerCase();
	if (lower.endsWith("dockerfile")) return "dockerfile";
	if (lower.endsWith("makefile")) return "makefile";
	return LANGUAGE_IDS[extname(lower)] ?? "plaintext";
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const diagnosticMessageToText = (message: Diagnostic["message"]): string =>
	typeof message === "string" ? message : message.value;

type WritableState = NodeJS.WritableStream & {
	readonly closed?: boolean;
	readonly destroyed?: boolean;
	readonly writable?: boolean;
	readonly writableEnded?: boolean;
	readonly writableFinished?: boolean;
};

const streamCanAcceptWrites = (stream: NodeJS.WritableStream): boolean => {
	const state = stream as WritableState;
	return (
		state.destroyed !== true &&
		state.closed !== true &&
		state.writableEnded !== true &&
		state.writableFinished !== true &&
		state.writable !== false
	);
};

class SafeMessageWriter implements MessageWriter {
	private readonly errorEmitter = new Emitter<[Error, Message | undefined, number | undefined]>();
	private readonly closeEmitter = new Emitter<void>();
	private errorCount = 0;
	private disposed = false;
	private writeQueue = Promise.resolve();

	private readonly onStreamError = (error: Error) => this.fireError(error);
	private readonly onStreamClose = () => this.closeEmitter.fire();

	constructor(private readonly stream: NodeJS.WritableStream) {
		stream.on("error", this.onStreamError);
		stream.on("close", this.onStreamClose);
	}

	get onError(): MessageWriter["onError"] {
		return this.errorEmitter.event;
	}

	get onClose(): MessageWriter["onClose"] {
		return this.closeEmitter.event;
	}

	write(message: Message): Promise<void> {
		this.writeQueue = this.writeQueue.then(
			() => this.doWrite(message),
			() => this.doWrite(message),
		);
		return this.writeQueue;
	}

	end(): void {
		if (!streamCanAcceptWrites(this.stream)) return;
		try {
			this.stream.end();
		} catch (error) {
			this.fireError(error);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stream.off("error", this.onStreamError);
		this.stream.off("close", this.onStreamClose);
		this.errorEmitter.dispose();
		this.closeEmitter.dispose();
	}

	private async doWrite(message: Message): Promise<void> {
		if (this.disposed || !streamCanAcceptWrites(this.stream)) return;

		let payload: Buffer;
		try {
			payload = Buffer.from(JSON.stringify(message), "utf8");
		} catch (error) {
			this.fireError(error, message);
			return;
		}

		const headers = `Content-Length: ${payload.byteLength}\r\n\r\n`;
		await this.writeChunk(headers, "ascii", message);
		await this.writeChunk(payload, undefined, message);
	}

	private async writeChunk(
		chunk: string | Buffer,
		encoding: BufferEncoding | undefined,
		message: Message,
	): Promise<void> {
		if (this.disposed || !streamCanAcceptWrites(this.stream)) return;

		await new Promise<void>((resolve) => {
			const callback = (error: Error | null | undefined) => {
				if (error !== undefined && error !== null) this.fireError(error, message);
				resolve();
			};

			try {
				if (typeof chunk === "string") {
					this.stream.write(chunk, encoding, callback);
				} else {
					this.stream.write(chunk, callback);
				}
			} catch (error) {
				this.fireError(error, message);
				resolve();
			}
		});
	}

	private fireError(error: unknown, message?: Message): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		this.errorCount += 1;
		this.errorEmitter.fire([normalized, message, this.errorCount]);
	}
}

export class LspClient {
	readonly serverId: string;
	readonly label: string;
	readonly root: string;
	readonly connection: MessageConnection;

	private readonly handle: LspServerHandle;
	private serverCapabilities: ServerCapabilities = {};
	private readonly diagnosticsByFile = new Map<string, Diagnostic[]>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	private readonly diagnosticRegistrations = new Map<string, DiagnosticRegistration>();
	private readonly diagnosticListeners = new Set<(file: string) => void>();
	private broken = false;
	private closing = false;
	private disposed = false;

	private constructor(handle: LspServerHandle, connection: MessageConnection) {
		this.handle = handle;
		this.connection = connection;
		this.serverId = handle.definition.id;
		this.label = handle.definition.label;
		this.root = handle.root;
	}

	static createEffect(handle: LspServerHandle): Effect.Effect<LspClient, unknown> {
		return Effect.tryPromise({
			try: () => LspClient.create(handle),
			catch: (cause) => cause,
		});
	}

	static async create(handle: LspServerHandle): Promise<LspClient> {
		const connection = createMessageConnection(
			new StreamMessageReader(handle.process.stdout),
			new SafeMessageWriter(handle.process.stdin),
		);
		const client = new LspClient(handle, connection);
		client.registerHandlers();
		connection.listen();

		const initializeResult = await withTimeout(
			connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
				rootUri: pathToFileURL(handle.root).href,
				processId: handle.process.pid,
				workspaceFolders: [{ name: handle.definition.label, uri: pathToFileURL(handle.root).href }],
				initializationOptions: handle.initializationOptions ?? {},
				capabilities: {
					window: { workDoneProgress: true },
					workspace: {
						configuration: true,
						workspaceFolders: true,
						diagnostics: { refreshSupport: false },
					},
					textDocument: {
						synchronization: { didOpen: true, didChange: true, didSave: true, didClose: true },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
						implementation: { dynamicRegistration: false },
						callHierarchy: { dynamicRegistration: false },
						rename: { dynamicRegistration: false, prepareSupport: false },
						codeAction: {
							dynamicRegistration: false,
							codeActionLiteralSupport: {
								codeActionKind: { valueSet: ["quickfix", "refactor", "source.organizeImports"] },
							},
						},
						formatting: { dynamicRegistration: false },
						diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
						publishDiagnostics: { versionSupport: false },
					},
				},
			}),
			INITIALIZE_TIMEOUT_MS,
			`${handle.definition.id} initialize`,
		).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			throw LspInitializeError.make({ serverId: handle.definition.id, reason });
		});
		client.serverCapabilities = initializeResult.capabilities ?? {};

		await connection.sendNotification("initialized", {});
		handle.process.stderr.resume();
		handle.process.on("exit", () => {
			client.broken = true;
		});
		handle.process.stdin.on("error", () => {
			client.broken = true;
		});

		return client;
	}

	get status(): LspClientStatus {
		return {
			serverId: this.serverId,
			label: this.label,
			root: this.root,
			status: this.broken ? "broken" : "connected",
		};
	}

	get diagnostics(): ReadonlyMap<string, ReadonlyArray<Diagnostic>> {
		return this.diagnosticsByFile;
	}

	supportsOperation(operation: string): boolean {
		switch (operation) {
			case "definition":
				return this.hasProvider(this.serverCapabilities.definitionProvider);
			case "references":
				return this.hasProvider(this.serverCapabilities.referencesProvider);
			case "hover":
				return this.hasProvider(this.serverCapabilities.hoverProvider);
			case "documentSymbol":
				return this.hasProvider(this.serverCapabilities.documentSymbolProvider);
			case "workspaceSymbol":
				return this.hasProvider(this.serverCapabilities.workspaceSymbolProvider);
			case "implementation":
				return this.hasProvider(this.serverCapabilities.implementationProvider);
			case "prepareCallHierarchy":
			case "incomingCalls":
			case "outgoingCalls":
				return this.hasProvider(this.serverCapabilities.callHierarchyProvider);
			case "rename":
				return this.hasProvider(this.serverCapabilities.renameProvider);
			case "codeAction":
			case "organizeImports":
				return this.hasProvider(this.serverCapabilities.codeActionProvider);
			case "formatting":
				return this.hasProvider(this.serverCapabilities.documentFormattingProvider);
			case "diagnostics":
				return true;
			default:
				return false;
		}
	}

	openEffect(file: string, waitForDiagnostics: boolean): Effect.Effect<void, unknown> {
		return Effect.tryPromise({
			try: () => this.open(file, waitForDiagnostics),
			catch: (cause) => cause,
		});
	}

	async open(file: string, waitForDiagnostics: boolean): Promise<void> {
		const text = await readFile(file, "utf8");
		if (!this.canSend()) {
			this.broken = true;
			return;
		}

		const uri = pathToFileURL(file).href;
		const open = this.openDocuments.get(file);
		if (open === undefined) {
			this.openDocuments.set(file, { version: 1, text });
			await this.notifyWatchedFile(file, FILE_CHANGE_CREATED);
			await this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForPath(file),
					version: 1,
					text,
				},
			});
			await this.notifySave(file, text);
		} else if (open.text !== text) {
			const version = open.version + 1;
			this.openDocuments.set(file, { version, text });
			await this.notifyWatchedFile(file, FILE_CHANGE_CHANGED);
			await this.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges:
					syncKind(this.serverCapabilities) === TEXT_DOCUMENT_SYNC_INCREMENTAL
						? [{ range: { start: { line: 0, character: 0 }, end: endPosition(open.text) }, text }]
						: [{ text }],
			});
			await this.notifySave(file, text);
		}

		if (waitForDiagnostics) {
			await Promise.all([
				this.waitForPushDiagnostics(file, DIAGNOSTIC_WAIT_TIMEOUT_MS),
				this.waitForDiagnosticRegistration(DIAGNOSTIC_WAIT_TIMEOUT_MS).then(() =>
					Promise.all([this.pullDocumentDiagnostics(file), this.pullWorkspaceDiagnostics()]),
				),
			]);
		}
	}

	requestEffect<T>(method: string, params: unknown): Effect.Effect<T, unknown> {
		return Effect.tryPromise({
			try: () => this.request<T>(method, params),
			catch: (cause) => cause,
		});
	}

	async request<T>(method: string, params: unknown): Promise<T> {
		if (!this.canSend()) {
			this.broken = true;
			throw new Error(`${this.serverId} language server is not running`);
		}

		try {
			return await withTimeout(
				this.connection.sendRequest<T>(method, params),
				REQUEST_TIMEOUT_MS,
				`${this.serverId} ${method}`,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (reason.includes("timed out")) {
				throw LspRequestTimeout.make({ serverId: this.serverId, method, reason });
			}
			throw LspRequestError.make({ serverId: this.serverId, method, reason });
		}
	}

	shutdownEffect(): Effect.Effect<void, unknown> {
		return Effect.tryPromise({
			try: () => this.shutdown(),
			catch: (cause) => cause,
		});
	}

	async shutdown(): Promise<void> {
		if (this.disposed || this.closing) return;
		await this.closeOpenDocuments().catch(() => undefined);
		this.closing = true;

		try {
			if (!this.broken && streamCanAcceptWrites(this.handle.process.stdin)) {
				await withTimeout(
					this.connection.sendRequest("shutdown", null),
					SHUTDOWN_TIMEOUT_MS,
					`${this.serverId} shutdown`,
				);
				await this.connection.sendNotification("exit").catch(() => undefined);
			}
		} catch {
			// Fall through to process termination.
		} finally {
			this.disposed = true;
			this.broken = true;
			this.connection.dispose();
			if (!this.handle.process.killed) {
				this.handle.process.kill("SIGTERM");
			}
		}
	}

	private canSend(): boolean {
		return (
			!this.closing &&
			!this.disposed &&
			!this.broken &&
			streamCanAcceptWrites(this.handle.process.stdin)
		);
	}

	private hasProvider(provider: unknown): boolean {
		return provider !== undefined && provider !== null && provider !== false;
	}

	private async waitForDiagnosticRegistration(timeoutMs: number): Promise<void> {
		if (this.hasProvider(this.serverCapabilities.diagnosticProvider)) return;
		if (this.diagnosticRegistrations.size > 0) return;
		await wait(timeoutMs);
	}

	private async waitForPushDiagnostics(file: string, timeoutMs: number): Promise<void> {
		if (this.diagnosticsByFile.has(file)) return;
		await new Promise<void>((resolve) => {
			let finished = false;
			let timeout: NodeJS.Timeout | undefined;
			const finish = () => {
				if (finished) return;
				finished = true;
				if (timeout !== undefined) clearTimeout(timeout);
				this.diagnosticListeners.delete(listener);
				resolve();
			};
			const listener = (diagnosticFile: string) => {
				if (diagnosticFile === file) finish();
			};
			this.diagnosticListeners.add(listener);
			timeout = setTimeout(finish, timeoutMs);
		});
	}

	private async pullDocumentDiagnostics(file: string): Promise<void> {
		const documentIdentifiers = [...this.diagnosticRegistrations.values()]
			.filter((registration) => registration.registerOptions?.workspaceDiagnostics !== true)
			.map((registration) => registration.registerOptions?.identifier)
			.filter((identifier): identifier is string => identifier !== undefined);
		const supportsDocumentDiagnostics =
			this.hasProvider(this.serverCapabilities.diagnosticProvider) ||
			documentIdentifiers.length > 0;
		if (!supportsDocumentDiagnostics) return;

		const requests = [
			...(this.hasProvider(this.serverCapabilities.diagnosticProvider) ? [undefined] : []),
			...documentIdentifiers,
		];
		await Promise.all(
			requests.map(async (identifier) => {
				const report = await withTimeout(
					this.connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
						...(identifier ? { identifier } : {}),
						textDocument: { uri: pathToFileURL(file).href },
					}),
					REQUEST_TIMEOUT_MS,
					`${this.serverId} textDocument/diagnostic`,
				).catch(() => null);
				if (report === null) return;
				this.mergeDiagnosticReport(file, report);
			}),
		);
	}

	private async pullWorkspaceDiagnostics(): Promise<void> {
		const workspaceIdentifiers = [...this.diagnosticRegistrations.values()]
			.filter((registration) => registration.registerOptions?.workspaceDiagnostics === true)
			.map((registration) => registration.registerOptions?.identifier)
			.filter((identifier): identifier is string => identifier !== undefined);
		if (workspaceIdentifiers.length === 0) return;

		await Promise.all(
			workspaceIdentifiers.map(async (identifier) => {
				const report = await withTimeout(
					this.connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
						identifier,
						previousResultIds: [],
					}),
					REQUEST_TIMEOUT_MS,
					`${this.serverId} workspace/diagnostic`,
				).catch(() => null);
				if (report === null) return;
				for (const item of report.items ?? []) {
					if (item.uri === undefined || !Array.isArray(item.items)) continue;
					const file = getFilePath(item.uri);
					if (file === undefined) continue;
					this.diagnosticsByFile.set(
						file,
						this.dedupeDiagnostics([...(this.diagnosticsByFile.get(file) ?? []), ...item.items]),
					);
				}
			}),
		);
	}

	private mergeDiagnosticReport(file: string, report: DocumentDiagnosticReport): void {
		if (Array.isArray(report.items)) {
			this.diagnosticsByFile.set(
				file,
				this.dedupeDiagnostics([...(this.diagnosticsByFile.get(file) ?? []), ...report.items]),
			);
		}
		for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
			const relatedFile = getFilePath(uri);
			if (relatedFile === undefined) continue;
			this.mergeDiagnosticReport(relatedFile, related);
		}
	}

	private dedupeDiagnostics(diagnostics: ReadonlyArray<Diagnostic>): Diagnostic[] {
		const seen = new Set<string>();
		return diagnostics.filter((diagnostic) => {
			const key = JSON.stringify({
				code: diagnostic.code,
				severity: diagnostic.severity,
				message: diagnosticMessageToText(diagnostic.message),
				source: diagnostic.source,
				range: diagnostic.range,
			});
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	private async notifyWatchedFile(file: string, type: number): Promise<void> {
		await this.notify("workspace/didChangeWatchedFiles", {
			changes: [{ uri: pathToFileURL(file).href, type }],
		});
	}

	private async notifySave(file: string, text: string): Promise<void> {
		await this.notify("textDocument/didSave", {
			textDocument: { uri: pathToFileURL(file).href },
			text,
		});
	}

	private async closeOpenDocuments(): Promise<void> {
		await Promise.all(
			[...this.openDocuments.keys()].map(async (file) => {
				await this.notify("textDocument/didClose", {
					textDocument: { uri: pathToFileURL(file).href },
				});
			}),
		);
		this.openDocuments.clear();
	}

	private async notify(method: string, params: unknown): Promise<void> {
		if (!this.canSend()) return;

		try {
			await this.connection.sendNotification(method, params);
		} catch {
			this.broken = true;
		}
	}

	private registerHandlers(): void {
		this.connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
			if (!isPublishDiagnostics(params)) return;
			const file = getFilePath(params.uri);
			if (file === undefined) return;
			this.diagnosticsByFile.set(file, params.diagnostics);
			for (const listener of this.diagnosticListeners) listener(file);
		});

		this.connection.onRequest("window/workDoneProgress/create", async () => null);
		this.connection.onRequest("workspace/workspaceFolders", async () => [
			{ name: this.handle.definition.label, uri: pathToFileURL(this.root).href },
		]);
		this.connection.onRequest("workspace/configuration", async () => []);
		this.connection.onRequest("workspace/diagnostic/refresh", async () => null);
		this.connection.onRequest("client/registerCapability", async (params: unknown) => {
			const registrations =
				isRecord(params) && Array.isArray(params.registrations) ? params.registrations : [];
			for (const registration of registrations) {
				if (!isDiagnosticRegistration(registration)) continue;
				if (registration.method !== "textDocument/diagnostic") continue;
				this.diagnosticRegistrations.set(registration.id, registration);
			}
			return null;
		});
		this.connection.onRequest("client/unregisterCapability", async (params: unknown) => {
			const registrations =
				isRecord(params) && Array.isArray(params.unregisterations) ? params.unregisterations : [];
			for (const registration of registrations) {
				if (!isRecord(registration)) continue;
				if (registration.method !== "textDocument/diagnostic") continue;
				if (typeof registration.id !== "string") continue;
				this.diagnosticRegistrations.delete(registration.id);
			}
			return null;
		});
	}
}

const isDiagnosticArray = (value: unknown): value is Diagnostic[] => Array.isArray(value);

const isDiagnosticRegistration = (value: unknown): value is DiagnosticRegistration => {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.method !== "string") return false;
	if (value.registerOptions === undefined) return true;
	if (!isRecord(value.registerOptions)) return false;
	return (
		(value.registerOptions.identifier === undefined ||
			typeof value.registerOptions.identifier === "string") &&
		(value.registerOptions.workspaceDiagnostics === undefined ||
			typeof value.registerOptions.workspaceDiagnostics === "boolean")
	);
};

const isPublishDiagnostics = (
	value: unknown,
): value is { uri: string; diagnostics: Diagnostic[] } => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.uri === "string" && isDiagnosticArray(record.diagnostics);
};
