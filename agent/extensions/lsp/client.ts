import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";

import type { LspServerHandle } from "./server";

const INITIALIZE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_SETTLE_MS = 250;

interface ServerCapabilities {
	textDocumentSync?: unknown;
	diagnosticProvider?: unknown;
}

interface OpenDocument {
	version: number;
	text: string;
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

const languageIdForPath = (file: string): string => {
	switch (extname(file).toLowerCase()) {
		case ".ts":
			return "typescript";
		case ".tsx":
			return "typescriptreact";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".jsx":
			return "javascriptreact";
		case ".json":
			return "json";
		case ".jsonc":
			return "jsonc";
		case ".css":
			return "css";
		case ".scss":
			return "scss";
		case ".less":
			return "less";
		case ".html":
		case ".htm":
			return "html";
		case ".py":
		case ".pyi":
			return "python";
		case ".rs":
			return "rust";
		case ".go":
			return "go";
		case ".sh":
		case ".bash":
		case ".zsh":
			return "shellscript";
		case ".yaml":
		case ".yml":
			return "yaml";
		default:
			return "plaintext";
	}
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class LspClient {
	readonly serverId: string;
	readonly label: string;
	readonly root: string;
	readonly connection: MessageConnection;

	private readonly handle: LspServerHandle;
	private readonly diagnosticsByFile = new Map<string, Diagnostic[]>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	private broken = false;

	private constructor(handle: LspServerHandle, connection: MessageConnection) {
		this.handle = handle;
		this.connection = connection;
		this.serverId = handle.definition.id;
		this.label = handle.definition.label;
		this.root = handle.root;
	}

	static async create(handle: LspServerHandle): Promise<LspClient> {
		const connection = createMessageConnection(
			new StreamMessageReader(handle.process.stdout),
			new StreamMessageWriter(handle.process.stdin),
		);
		const client = new LspClient(handle, connection);
		client.registerHandlers();
		connection.listen();

		await withTimeout(
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
						synchronization: { didOpen: true, didChange: true },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
						implementation: { dynamicRegistration: false },
						callHierarchy: { dynamicRegistration: false },
						diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
						publishDiagnostics: { versionSupport: false },
					},
				},
			}),
			INITIALIZE_TIMEOUT_MS,
			`${handle.definition.id} initialize`,
		);

		await connection.sendNotification("initialized", {});
		handle.process.stderr.resume();
		handle.process.on("exit", () => {
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

	async open(file: string, waitForDiagnostics: boolean): Promise<void> {
		const text = await readFile(file, "utf8");
		const uri = pathToFileURL(file).href;
		const open = this.openDocuments.get(file);
		if (open === undefined) {
			this.openDocuments.set(file, { version: 1, text });
			this.connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForPath(file),
					version: 1,
					text,
				},
			});
		} else if (open.text !== text) {
			const version = open.version + 1;
			this.openDocuments.set(file, { version, text });
			this.connection.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
		}

		if (waitForDiagnostics) {
			await wait(DIAGNOSTIC_SETTLE_MS);
		}
	}

	async request<T>(method: string, params: unknown): Promise<T> {
		return await withTimeout(
			this.connection.sendRequest<T>(method, params),
			REQUEST_TIMEOUT_MS,
			`${this.serverId} ${method}`,
		);
	}

	async shutdown(): Promise<void> {
		try {
			await withTimeout(
				this.connection.sendRequest("shutdown", null),
				SHUTDOWN_TIMEOUT_MS,
				`${this.serverId} shutdown`,
			);
			this.connection.sendNotification("exit");
		} catch {
			// Fall through to process termination.
		}

		this.connection.dispose();
		if (!this.handle.process.killed) {
			this.handle.process.kill("SIGTERM");
		}
	}

	private registerHandlers(): void {
		this.connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
			if (!isPublishDiagnostics(params)) return;
			const file = getFilePath(params.uri);
			if (file === undefined) return;
			this.diagnosticsByFile.set(file, params.diagnostics);
		});

		this.connection.onRequest("window/workDoneProgress/create", async () => null);
		this.connection.onRequest("workspace/workspaceFolders", async () => [
			{ name: this.handle.definition.label, uri: pathToFileURL(this.root).href },
		]);
		this.connection.onRequest("workspace/configuration", async () => []);
		this.connection.onRequest("workspace/diagnostic/refresh", async () => null);
		this.connection.onRequest("client/registerCapability", async () => null);
		this.connection.onRequest("client/unregisterCapability", async () => null);
	}
}

const isDiagnosticArray = (value: unknown): value is Diagnostic[] => Array.isArray(value);

const isPublishDiagnostics = (
	value: unknown,
): value is { uri: string; diagnostics: Diagnostic[] } => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.uri === "string" && isDiagnosticArray(record.diagnostics);
};
