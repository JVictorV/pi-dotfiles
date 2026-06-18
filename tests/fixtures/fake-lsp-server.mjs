import { writeFile } from "node:fs/promises";

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);
const documents = new Map();
const languageIds = new Map();
const watchedChanges = new Map();
const lifecycle = { saves: 0, closes: 0 };
let hoverErrorsRemaining = Number(process.env.FAKE_LSP_HOVER_ERROR_COUNT ?? 0);

const location = (uri, line, character) => ({
	uri,
	range: {
		start: { line, character },
		end: { line, character: character + 4 },
	},
});

const fakeDiagnostic = (message = "fake diagnostic") => ({
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 4 },
	},
	severity: 1,
	message,
	source: "fake-lsp",
});

const publishDiagnostics = (uri) => {
	if (process.env.FAKE_LSP_PULL_DIAGNOSTICS_ONLY === "1") return;
	const delay = Number(process.env.FAKE_LSP_PUBLISH_DIAGNOSTICS_DELAY_MS ?? 0);
	setTimeout(() => {
		connection.sendNotification("textDocument/publishDiagnostics", {
			uri,
			diagnostics: [fakeDiagnostic()],
		});
	}, delay);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

connection.onRequest("initialize", async () => {
	const initializeDelay = Number(process.env.FAKE_LSP_INITIALIZE_DELAY_MS ?? 0);
	if (initializeDelay > 0) await wait(initializeDelay);

	if (process.env.FAKE_LSP_INITIALIZE_ERROR === "1") {
		throw new Error("fake initialize failed");
	}

	const capabilities = {
		textDocumentSync: process.env.FAKE_LSP_REQUIRE_INCREMENTAL_CHANGE === "1" ? 2 : 1,
		diagnosticProvider: true,
		hoverProvider: true,
		definitionProvider: true,
		referencesProvider: true,
		documentSymbolProvider: true,
		workspaceSymbolProvider: true,
		implementationProvider: true,
		callHierarchyProvider: true,
	};
	if (
		process.env.FAKE_LSP_DYNAMIC_DOCUMENT_DIAGNOSTICS === "1" ||
		process.env.FAKE_LSP_WORKSPACE_DIAGNOSTICS === "1" ||
		process.env.FAKE_LSP_NO_PULL_DIAGNOSTICS === "1"
	) {
		delete capabilities.diagnosticProvider;
	}
	if (process.env.FAKE_LSP_NO_DEFINITION === "1") delete capabilities.definitionProvider;
	return { capabilities };
});

connection.onNotification("initialized", async () => {
	if (process.env.FAKE_LSP_DYNAMIC_DOCUMENT_DIAGNOSTICS === "1") {
		await connection.sendRequest("client/registerCapability", {
			registrations: [
				{
					id: "fake-document-diagnostics",
					method: "textDocument/diagnostic",
					registerOptions: { identifier: "fake-document-diagnostics" },
				},
			],
		});
	}
	if (process.env.FAKE_LSP_WORKSPACE_DIAGNOSTICS === "1") {
		await connection.sendRequest("client/registerCapability", {
			registrations: [
				{
					id: "fake-workspace-diagnostics",
					method: "textDocument/diagnostic",
					registerOptions: {
						identifier: "fake-workspace-diagnostics",
						workspaceDiagnostics: true,
					},
				},
			],
		});
	}
});

connection.onNotification("textDocument/didOpen", (params) => {
	documents.set(params.textDocument.uri, params.textDocument.text);
	languageIds.set(params.textDocument.uri, params.textDocument.languageId);
	publishDiagnostics(params.textDocument.uri);
});

connection.onNotification("textDocument/didChange", (params) => {
	const change = params.contentChanges.at(-1);
	if (process.env.FAKE_LSP_REQUIRE_INCREMENTAL_CHANGE === "1" && change?.range === undefined) {
		documents.set(params.textDocument.uri, "missing incremental range");
	} else {
		documents.set(params.textDocument.uri, change?.text ?? "");
	}
	publishDiagnostics(params.textDocument.uri);
});

connection.onNotification("workspace/didChangeWatchedFiles", (params) => {
	for (const change of params.changes ?? []) {
		watchedChanges.set(change.uri, (watchedChanges.get(change.uri) ?? 0) + 1);
	}
});

connection.onNotification("textDocument/didSave", () => {
	lifecycle.saves += 1;
});

connection.onNotification("textDocument/didClose", () => {
	lifecycle.closes += 1;
});

connection.onRequest("textDocument/diagnostic", (params) => ({
	kind: "full",
	items: [
		fakeDiagnostic(
			params.identifier === "fake-document-diagnostics"
				? "fake dynamic document diagnostic"
				: "fake pull diagnostic",
		),
	],
}));

connection.onRequest("workspace/diagnostic", () => ({
	kind: "full",
	items: [
		{
			uri: documents.keys().next().value,
			items: [fakeDiagnostic("fake workspace diagnostic")],
		},
	],
}));

connection.onRequest("textDocument/hover", (params) => {
	if (hoverErrorsRemaining > 0) {
		hoverErrorsRemaining -= 1;
		throw new Error("fake hover failed");
	}

	const watchedSuffix =
		process.env.FAKE_LSP_REPORT_WATCHED === "1"
			? ` watched=${watchedChanges.get(params.textDocument.uri) ?? 0}`
			: "";
	const languageSuffix =
		process.env.FAKE_LSP_REPORT_LANGUAGE_ID === "1"
			? ` language=${languageIds.get(params.textDocument.uri) ?? ""}`
			: "";
	return {
		contents: {
			kind: "markdown",
			value: `hover for ${params.textDocument.uri} at ${params.position.line}:${params.position.character} text=${documents.get(params.textDocument.uri) ?? ""}${watchedSuffix}${languageSuffix}`,
		},
	};
});

connection.onRequest("textDocument/definition", (params) => {
	if (process.env.FAKE_LSP_MALFORMED_DEFINITION === "1") {
		return [{ uri: params.textDocument.uri, range: { start: { line: "bad", character: 2 } } }];
	}
	return [location(params.textDocument.uri, 1, 2)];
});
connection.onRequest("textDocument/references", (params) => [
	location(params.textDocument.uri, 0, 0),
	location(params.textDocument.uri, 2, 4),
]);
connection.onRequest("textDocument/implementation", (params) => [
	location(params.textDocument.uri, 3, 1),
]);

connection.onRequest("textDocument/documentSymbol", (params) => [
	{
		name: "fakeSymbol",
		kind: 12,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
		selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
		children: [],
	},
]);

connection.onRequest("workspace/symbol", () => [
	{
		name: "workspaceFakeSymbol",
		kind: 12,
		location: location(`file://${process.cwd()}/main.fake`, 4, 2),
	},
]);

connection.onRequest("textDocument/prepareCallHierarchy", (params) => [
	{
		name: "callerTarget",
		kind: 12,
		uri: params.textDocument.uri,
		range: { start: params.position, end: params.position },
		selectionRange: { start: params.position, end: params.position },
	},
]);

connection.onRequest("callHierarchy/incomingCalls", (params) => [
	{
		from: {
			...params.item,
			name: "incomingCaller",
			range: { start: { line: 5, character: 3 }, end: { line: 5, character: 8 } },
			selectionRange: { start: { line: 5, character: 3 }, end: { line: 5, character: 8 } },
		},
		fromRanges: [],
	},
]);

connection.onRequest("callHierarchy/outgoingCalls", (params) => [
	{
		to: {
			...params.item,
			name: "outgoingCallee",
			range: { start: { line: 6, character: 1 }, end: { line: 6, character: 8 } },
			selectionRange: { start: { line: 6, character: 1 }, end: { line: 6, character: 8 } },
		},
		fromRanges: [],
	},
]);

connection.onRequest("shutdown", async () => {
	if (process.env.FAKE_LSP_LIFECYCLE_FILE) {
		await writeFile(process.env.FAKE_LSP_LIFECYCLE_FILE, JSON.stringify(lifecycle), "utf8");
	}
	return null;
});
connection.onNotification("exit", () => process.exit(0));

connection.listen();
