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

const location = (uri, line, character) => ({
	uri,
	range: {
		start: { line, character },
		end: { line, character: character + 4 },
	},
});

const publishDiagnostics = (uri) => {
	connection.sendNotification("textDocument/publishDiagnostics", {
		uri,
		diagnostics: [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 4 },
				},
				severity: 1,
				message: "fake diagnostic",
				source: "fake-lsp",
			},
		],
	});
};

connection.onRequest("initialize", () => {
	if (process.env.FAKE_LSP_INITIALIZE_ERROR === "1") {
		throw new Error("fake initialize failed");
	}

	const capabilities = {
		textDocumentSync: 1,
		hoverProvider: true,
		definitionProvider: true,
		referencesProvider: true,
		documentSymbolProvider: true,
		workspaceSymbolProvider: true,
		implementationProvider: true,
		callHierarchyProvider: true,
	};
	if (process.env.FAKE_LSP_NO_DEFINITION === "1") delete capabilities.definitionProvider;
	return { capabilities };
});

connection.onNotification("initialized", () => {});

connection.onNotification("textDocument/didOpen", (params) => {
	documents.set(params.textDocument.uri, params.textDocument.text);
	publishDiagnostics(params.textDocument.uri);
});

connection.onNotification("textDocument/didChange", (params) => {
	documents.set(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? "");
	publishDiagnostics(params.textDocument.uri);
});

connection.onRequest("textDocument/hover", (params) => ({
	contents: {
		kind: "markdown",
		value: `hover for ${params.textDocument.uri} at ${params.position.line}:${params.position.character} text=${documents.get(params.textDocument.uri) ?? ""}`,
	},
}));

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

connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
