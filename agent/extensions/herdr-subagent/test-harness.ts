import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { env as processEnv } from "node:process";

import { herdrSdkLayerFromOptions, HerdrSdk } from "@herdr/sdk";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "@effect/vitest";

import { configurationProvider } from "./environment";
import type { ModelRegistryForResolution } from "./model-resolver";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type HerdrRuntimeRequirements = ChildProcessSpawner | FileSystem | HerdrSdk | Path;

/** One NDJSON request captured by the temporary Herdr protocol server. */
export type WireRequest = {
	readonly id: string;
	readonly method: string;
	readonly params: Readonly<Record<string, unknown>>;
};

const nodeLayer = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);

/** Run an extension Effect with fresh Node and Herdr SDK layers for the active test server. */
export const runHerdrSubagentEffect = <A>(
	effect: Effect.Effect<A, unknown, HerdrRuntimeRequirements>,
	options?: { readonly signal?: AbortSignal },
): Promise<A> => {
	const socketPath = activeServers.at(-1)?.socketPath ?? path.join(tmpdir(), "no-live-herdr.sock");
	const configLayer = ConfigProvider.layer(configurationProvider());
	const layer = Layer.merge(nodeLayer, herdrSdkLayerFromOptions({ socketPath })).pipe(
		Layer.provideMerge(configLayer),
	);
	const runtime = ManagedRuntime.make(layer);
	return runtime.runPromise(effect, options).finally(() => runtime.dispose());
};

/** Result shape returned by a pi tool execution in herdr-subagent tests. */
export interface ToolResult {
	/** Tool content blocks returned to pi. */
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	/** Optional structured details returned by the tool. */
	readonly details?: unknown;
	/** Whether the result represents a handled tool error. */
	readonly isError?: boolean;
}

/** Registered tool definition captured by the fake pi extension API. */
export interface ToolDefinition {
	/** Machine name of the registered tool. */
	readonly name: string;
	/** Model-facing operating rules contributed by the tool. */
	readonly promptGuidelines?: ReadonlyArray<string>;
	/** Execute the registered tool. */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: FakeContext,
	): Promise<ToolResult>;
}

export type SessionEvent =
	| "session_start"
	| "session_shutdown"
	| "input"
	| "agent_start"
	| "agent_end"
	| "agent_settled"
	| "context";

export interface SentCustomMessage {
	readonly message: unknown;
	readonly options: unknown;
}

export interface SentUserMessage {
	readonly content: unknown;
	readonly options: unknown;
}

type SessionHandler = (event: { readonly type: SessionEvent } | unknown, ctx?: unknown) => unknown;

/** Minimal fake pi API used by the herdr_subagent tool integration tests. */
export interface FakePi {
	/** Capture a registered tool definition. */
	registerTool(tool: ToolDefinition): void;
	/** Subscribe to session lifecycle events used by the extension. */
	on(event: SessionEvent, handler: SessionHandler): void;
	/** Capture custom messages injected by the extension. */
	sendMessage(message: unknown, options?: unknown): void;
	/** Capture user messages injected by the extension. */
	sendUserMessage(content: unknown, options?: unknown): void;
}

/** Loaded herdr_subagent tool plus fake pi observations. */
export interface LoadedTool {
	/** Captured herdr_subagent tool definition. */
	readonly tool: ToolDefinition;
	/** Fake pi API instance used to load the extension. */
	readonly pi: FakePi;
	/** Custom messages injected through pi.sendMessage. */
	readonly sentMessages: SentCustomMessage[];
	/** User messages injected through pi.sendUserMessage. */
	readonly sentUserMessages: SentUserMessage[];
	/** Apply the registered model-context handlers to a fresh message array. */
	transformContext(
		messages: ReadonlyArray<unknown>,
		branch?: ReadonlyArray<SessionEntry>,
	): Promise<ReadonlyArray<unknown>>;
	/** Dispatch a fake session lifecycle or agent event without awaiting handlers. */
	dispatch(event: SessionEvent, payload?: unknown, ctx?: unknown): void;
	/** Dispatch a fake session lifecycle or agent event and await asynchronous handlers. */
	dispatchAsync(event: SessionEvent, payload?: unknown, ctx?: unknown): Promise<void>;
}

/** Minimal pi tool context used by herdr_subagent tool execution tests. */
export interface FakeContext {
	/** Current working directory supplied to the tool. */
	readonly cwd: string;
	/** Whether a UI is available for confirmations. */
	readonly hasUI: boolean;
	/** Fake UI methods used by the tool. */
	readonly ui: { readonly confirm: (title: string, message: string) => Promise<boolean> };
	/** Optional fake pi model registry for spawn model resolution tests. */
	readonly modelRegistry?: ModelRegistryForResolution;
}

type ExtensionFactory = (pi: FakePi) => void;

const envRecord = (): Record<string, string | undefined> => processEnv;

const controlledEnvironmentNames = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"HERDR_SUBAGENT_NAME",
	"HERDR_SUBAGENT_ALLOW_SPAWN",
	"HERDR_SUBAGENT_RESULT_SOCK",
	"PATH",
	"PI_CODING_AGENT_DIR",
	"FAKE_HERDR_PROTOCOL",
	"FAKE_HERDR_MALFORMED_RESPONSE",
	"FAKE_HERDR_TAB_CLOSE_FAIL",
	"FAKE_HERDR_TAB_GET_FAIL",
	"FAKE_HERDR_TAB_GET_MALFORMED",
	"FAKE_HERDR_WAIT_HANG",
	"FAKE_HERDR_AGENT_STATUS",
	"FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE",
	"FAKE_HERDR_AGENTS",
	"FAKE_HERDR_PANE_RUN_FAIL",
	"FAKE_HERDR_PANE_RUN_FAIL_AFTER_DELAY",
	"FAKE_HERDR_PANE_RUN_DELAY_MESSAGE",
	"FAKE_HERDR_PANE_RUN_DELAY_MS",
	"FAKE_HERDR_PANE_CURRENT_FAIL",
	"FAKE_HERDR_PANE_CURRENT_PANE_ID",
	"FAKE_HERDR_PANE_CURRENT_TERMINAL_ID",
	"FAKE_HERDR_AGENT_LIST_FAIL",
	"FAKE_HERDR_AGENT_LIST_TERMINAL_ID",
	"FAKE_HERDR_AGENT_LIST_PANE_ID",
	"FAKE_HERDR_AGENT_LIST_TAB_ID",
];

const originalEnv = Object.fromEntries(
	controlledEnvironmentNames.map((name) => [name, envRecord()[name]]),
);

interface TestServer {
	readonly socketPath: string;
	readonly requests: WireRequest[];
	close(): Promise<void>;
}

let tempRoots: string[] = [];
let loadedTools: LoadedTool[] = [];
let activeServers: TestServer[] = [];

/** Restore environment variables and remove all temporary sockets and roots. */
export const cleanupHarness = async (): Promise<void> => {
	for (const loaded of loadedTools) await loaded.dispatchAsync("session_shutdown");
	loadedTools = [];
	const servers = activeServers;
	activeServers = [];
	await Promise.all(servers.map((server) => server.close()));
	restoreEnv();
	const roots = tempRoots;
	tempRoots = [];
	for (const root of roots) await rm(root, { recursive: true, force: true });
};

/** Set or unset an environment variable for the current test process. */
export const setEnv = (name: string, value: string | undefined): void => {
	vi.stubEnv(name, value);
};

/** Simulate whether the current pi session is a spawned herdr subagent session. */
export const setSubagentSession = (name: string | undefined, allowSpawn = false): void => {
	setEnv("HERDR_SUBAGENT_NAME", name);
	setEnv("HERDR_SUBAGENT_ALLOW_SPAWN", name && allowSpawn ? "1" : undefined);
};

/** Create a temporary root directory that will be removed by cleanupHarness. */
export const makeTempRoot = async (prefix = "pi-herdr-subagent-test-"): Promise<string> => {
	const root = await mkdtemp(path.join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
};

/** Build a fake tool execution context rooted at the provided cwd. */
export const makeContext = (
	cwd: string,
	modelRegistry?: ModelRegistryForResolution,
): FakeContext => ({
	cwd,
	hasUI: false,
	ui: { confirm: async () => true },
	...(modelRegistry ? { modelRegistry } : {}),
});

/** Load the extension default export and return the captured herdr_subagent tool. */
export const loadToolWithFakePi = async (agentDir: string): Promise<LoadedTool> => {
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv(
		"HERDR_SOCKET_PATH",
		activeServers.at(-1)?.socketPath ?? path.join(path.dirname(agentDir), "no-herdr.sock"),
	);
	const registered: ToolDefinition[] = [];
	const sentMessages: SentCustomMessage[] = [];
	const sentUserMessages: SentUserMessage[] = [];
	const handlers = new Map<SessionEvent, SessionHandler[]>();
	const pi: FakePi = {
		registerTool(tool) {
			registered.push(tool);
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
		sendUserMessage(content, options) {
			sentUserMessages.push({ content, options });
		},
	};

	const moduleUrl = new URL(`./index.ts?test=${randomUUID()}`, import.meta.url).href;
	const imported: unknown = await import(moduleUrl);
	if (!isRecord(imported)) {
		return loadedMissingTool(
			pi,
			sentMessages,
			sentUserMessages,
			"extension module did not import as an object",
		);
	}
	const factory = imported.default;
	if (!isExtensionFactory(factory)) {
		return loadedMissingTool(
			pi,
			sentMessages,
			sentUserMessages,
			"extension module default export is not a function",
		);
	}
	factory(pi);

	const tool = registered.find((candidate) => candidate.name === "herdr_subagent");
	if (!tool) {
		return loadedMissingTool(
			pi,
			sentMessages,
			sentUserMessages,
			"herdr_subagent tool was not registered",
		);
	}
	const loaded: LoadedTool = {
		tool,
		pi,
		sentMessages,
		sentUserMessages,
		async transformContext(messages, branch = []) {
			let current = [...messages];
			for (const handler of handlers.get("context") ?? []) {
				const result = await handler(
					{ type: "context", messages: current },
					{ sessionManager: { getBranch: () => branch } },
				);
				if (isRecord(result) && Array.isArray(result.messages)) current = result.messages;
			}
			return current;
		},
		dispatch(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) handler(payload ?? { type: event }, ctx);
		},
		async dispatchAsync(event, payload, ctx) {
			await Promise.all(
				(handlers.get(event) ?? []).map((handler) => handler(payload ?? { type: event }, ctx)),
			);
		},
	};
	loadedTools.push(loaded);
	return loaded;
};

/** Load the extension default export and return the captured herdr_subagent tool. */
export const loadTool = async (agentDir: string): Promise<ToolDefinition> =>
	(await loadToolWithFakePi(agentDir)).tool;

/** Start a real temporary Unix socket server that speaks Herdr protocol 21. */
export const installFakeHerdr = async (
	root: string,
): Promise<{ readonly bin: string; readonly log: string }> => {
	const server = await startTestServer(root);
	activeServers.push(server);
	setEnv("HERDR_SOCKET_PATH", server.socketPath);
	setEnv("HERDR_PANE_ID", "wTest:p0");
	setSubagentSession(undefined);
	return { bin: path.dirname(server.socketPath), log: server.socketPath };
};

/** Return captured SDK wire requests for one test server. */
export const readHerdrRequests = (socketPath: string): ReadonlyArray<WireRequest> =>
	activeServers.find((server) => server.socketPath === socketPath)?.requests ?? [];

/** Write a fake agent definition into a test agent directory. */
export const writeAgent = async (
	agentDir: string,
	name: string,
	model: string,
	thinking?: string,
): Promise<void> => {
	const agentsDir = path.join(agentDir, "agents");
	await mkdir(agentsDir, { recursive: true });
	const thinkingLine = thinking ? `thinking: ${thinking}\n` : "";
	await writeFile(
		path.join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} test agent\nmodel: ${model}\n${thinkingLine}---\n\nYou are ${name}.\n`,
		"utf8",
	);
};

/** Return the first pane input text sent through the SDK. */
export const firstRunCommand = (requests: ReadonlyArray<WireRequest>): string | undefined => {
	const text = requests.find((request) => request.method === "pane.send_input")?.params.text;
	return typeof text === "string" ? text : undefined;
};

/** Return the last pane input text sent through the SDK. */
export const lastRunCommand = (requests: ReadonlyArray<WireRequest>): string | undefined => {
	const text = requests.filter((request) => request.method === "pane.send_input").at(-1)
		?.params.text;
	return typeof text === "string" ? text : undefined;
};

const restoreEnv = (): void => {
	for (const name of controlledEnvironmentNames) setEnv(name, originalEnv[name]);
};

const missingTool = (message: string): ToolDefinition => ({
	name: "herdr_subagent",
	async execute() {
		return { content: [{ type: "text", text: message }], details: { message }, isError: true };
	},
});

const loadedMissingTool = (
	pi: FakePi,
	sentMessages: SentCustomMessage[],
	sentUserMessages: SentUserMessage[],
	message: string,
): LoadedTool => {
	const loaded: LoadedTool = {
		tool: missingTool(message),
		pi,
		sentMessages,
		sentUserMessages,
		async transformContext(messages) {
			return messages;
		},
		dispatch() {},
		async dispatchAsync() {},
	};
	loadedTools.push(loaded);
	return loaded;
};

const parseWireJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isExtensionFactory = (value: unknown): value is ExtensionFactory =>
	typeof value === "function";

const startTestServer = async (root: string): Promise<TestServer> => {
	const socketPath = path.join(root, "herdr.sock");
	const requests: WireRequest[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		consumeRequests(socket, requests);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		requests,
		async close() {
			for (const socket of sockets) socket.destroy();
			await closeServer(server);
			await rm(socketPath, { force: true });
		},
	};
};

const consumeRequests = (socket: Socket, requests: WireRequest[]): void => {
	let input = "";
	socket.on("data", (chunk: Buffer) => {
		input += chunk.toString("utf8");
		for (;;) {
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const line = input.slice(0, newline);
			input = input.slice(newline + 1);
			handleRequestLine(socket, line, requests).then(undefined, () => socket.destroy());
		}
	});
};

const handleRequestLine = async (
	socket: Socket,
	line: string,
	requests: WireRequest[],
): Promise<void> => {
	const parsedJson = parseWireJson(line);
	if (Option.isNone(parsedJson)) {
		socket.destroy();
		return;
	}
	const parsed = parsedJson.value;
	if (!isWireRequest(parsed)) {
		socket.destroy();
		return;
	}
	requests.push(parsed);
	const reply = await responseFor(parsed);
	if (reply !== undefined && !socket.destroyed) {
		socket.end(typeof reply === "string" ? reply : `${JSON.stringify(reply)}\n`);
	}
};

const isWireRequest = (value: unknown): value is WireRequest =>
	isRecord(value) &&
	typeof value.id === "string" &&
	typeof value.method === "string" &&
	isRecord(value.params);

const responseFor = async (
	request: WireRequest,
): Promise<Record<string, unknown> | string | undefined> => {
	const ok = (result: Record<string, unknown>): Record<string, unknown> => ({
		id: request.id,
		result,
	});
	const fail = (message: string): Record<string, unknown> => ({
		id: request.id,
		error: { code: "fixture_rejected", message },
	});
	const params = request.params;
	switch (request.method) {
		case "ping":
			if (envRecord().FAKE_HERDR_MALFORMED_RESPONSE === "1") return "{malformed\n";
			return ok({
				type: "pong",
				version: "0.8.2",
				protocol: Number(envRecord().FAKE_HERDR_PROTOCOL ?? "21"),
			});
		case "pane.current": {
			if (envRecord().FAKE_HERDR_PANE_CURRENT_FAIL === "1") return fail("pane current failed");
			const callerPaneId = String(params.caller_pane_id ?? "wTest:p0");
			return ok({
				type: "pane_current",
				pane: paneFixture(callerPaneId === "wTest:p0" ? "root" : "subagent", {
					...params,
					pane_id: callerPaneId,
				}),
			});
		}
		case "tab.create":
			return ok({
				type: "tab_created",
				root_pane: paneFixture("subagent", params),
				tab: tabFixture(typeof params.label === "string" ? params.label : "agent: test"),
			});
		case "pane.send_input": {
			const text = typeof params.text === "string" ? params.text : "";
			if (envRecord().FAKE_HERDR_PANE_RUN_FAIL === "1") return fail("pane run failed");
			const delayMessage = envRecord().FAKE_HERDR_PANE_RUN_DELAY_MESSAGE;
			const delayMs = Number(envRecord().FAKE_HERDR_PANE_RUN_DELAY_MS ?? "0");
			if (delayMs > 0 && (!delayMessage || delayMessage === text)) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
			return envRecord().FAKE_HERDR_PANE_RUN_FAIL_AFTER_DELAY === "1"
				? fail("pane run failed after input")
				: ok({ type: "ok" });
		}
		case "pane.rename":
			return ok({ type: "pane_info", pane: paneFixture("subagent", params) });
		case "pane.close":
			return ok({ type: "ok" });
		case "tab.close":
			return envRecord().FAKE_HERDR_TAB_CLOSE_FAIL === "1"
				? fail(`unknown tab: ${String(params.tab_id ?? "")}`)
				: ok({ type: "ok" });
		case "tab.get":
			if (envRecord().FAKE_HERDR_TAB_GET_MALFORMED === "1") return "{malformed\n";
			return envRecord().FAKE_HERDR_TAB_GET_FAIL === "1"
				? {
						id: request.id,
						error: {
							code: "tab_not_found",
							message: `unknown tab: ${String(params.tab_id ?? "")}`,
						},
					}
				: ok({ type: "tab_info", tab: tabFixture("agent: test") });
		case "agent.get":
		case "agent.focus":
		case "agent.wait": {
			// Protocol 21 native targets do not include stable terminal ids. Those
			// must resolve through agent.list, and unknown panes must stay missing.
			const target = String(params.target ?? "");
			if (envRecord().FAKE_HERDR_AGENTS === "none" || target !== agentPaneId()) {
				return {
					id: request.id,
					error: { code: "agent_not_found", message: `agent target ${target} not found` },
				};
			}
			if (request.method === "agent.wait" && envRecord().FAKE_HERDR_WAIT_HANG === "1")
				return undefined;
			return ok({ type: "agent_info", agent: await agentFixture() });
		}
		case "agent.list":
			if (envRecord().FAKE_HERDR_AGENT_LIST_FAIL === "1") return fail("agent list failed");
			return ok({
				type: "agent_list",
				agents: envRecord().FAKE_HERDR_AGENTS === "none" ? [] : [await agentFixture()],
			});
		case "pane.read":
			return ok({
				type: "pane_read",
				read: {
					pane_id: String(params.pane_id ?? "wTest:p1"),
					tab_id: "wTest:t2",
					workspace_id: "wTest",
					text: "STATUS: done\nAll good.\n",
					source: params.source ?? "recent",
					format: "text",
					revision: 1,
					truncated: false,
				},
			});
		default:
			return fail(`unexpected test request: ${request.method}`);
	}
};

const paneFixture = (
	kind: "root" | "subagent",
	params: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
	const root = kind === "root";
	const cwd = typeof params.cwd === "string" ? params.cwd : "/workspace";
	return {
		pane_id:
			typeof params.pane_id === "string"
				? params.pane_id
				: root
					? (envRecord().FAKE_HERDR_PANE_CURRENT_PANE_ID ?? "wTest:p0")
					: "wTest:p1",
		terminal_id: root
			? (envRecord().FAKE_HERDR_PANE_CURRENT_TERMINAL_ID ?? "term-root")
			: "term-subagent",
		tab_id: root ? "wTest:t1" : "wTest:t2",
		workspace_id: "wTest",
		cwd,
		foreground_cwd: cwd,
		agent_status: "idle",
		focused: root,
		revision: 1,
		label: null,
	};
};

const agentPaneId = (): string => envRecord().FAKE_HERDR_AGENT_LIST_PANE_ID ?? "wTest:p1";

const agentFixture = async (): Promise<Record<string, unknown>> => ({
	pane_id: agentPaneId(),
	terminal_id: envRecord().FAKE_HERDR_AGENT_LIST_TERMINAL_ID ?? "term-subagent",
	tab_id: envRecord().FAKE_HERDR_AGENT_LIST_TAB_ID ?? "wTest:t2",
	workspace_id: "wTest",
	agent_status: await nextAgentStatus(),
	cwd: "/workspace",
	foreground_cwd: "/workspace",
	focused: false,
	revision: 1,
});

const tabFixture = (label: string): Record<string, unknown> => ({
	tab_id: "wTest:t2",
	workspace_id: "wTest",
	label,
	agent_status: "idle",
	focused: false,
	number: 2,
	pane_count: 1,
});

const nextAgentStatus = async (): Promise<string> => {
	let status = envRecord().FAKE_HERDR_AGENT_STATUS ?? "idle";
	const sequenceFile = envRecord().FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE;
	if (!sequenceFile) return status;
	const text = await readFile(sequenceFile, "utf8").catch(() => "");
	const statuses = text.split(/\r?\n/u).filter(Boolean);
	const next = statuses.shift();
	if (!next) return status;
	status = next;
	await writeFile(sequenceFile, statuses.length > 0 ? `${statuses.join("\n")}\n` : "", "utf8");
	return status;
};

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.close(() => resolve());
	});
