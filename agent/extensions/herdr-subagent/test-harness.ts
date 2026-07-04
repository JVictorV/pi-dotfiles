import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { env as processEnv } from "node:process";

import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

type HerdrRuntimeRequirements = ChildProcessSpawner | FileSystem | Path;

const nodeLayer = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);
const nodeRuntime = ManagedRuntime.make(nodeLayer);

/** Run a herdr-subagent Effect using the same Node runtime layers as the extension entrypoint. */
export const runHerdrSubagentEffect = <A>(
	effect: Effect.Effect<A, unknown, HerdrRuntimeRequirements>,
): Promise<A> => nodeRuntime.runPromise(effect);

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
	/** Execute the registered tool. */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: FakeContext,
	): Promise<ToolResult>;
}

export type SessionEvent = "session_shutdown";

export interface SentCustomMessage {
	readonly message: unknown;
	readonly options: unknown;
}

export interface SentUserMessage {
	readonly content: unknown;
	readonly options: unknown;
}

type SessionHandler = (event: { readonly type: SessionEvent }) => void;

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
	/** Dispatch a fake session lifecycle event. */
	dispatch(event: SessionEvent): void;
}

/** Minimal pi tool context used by herdr_subagent tool execution tests. */
export interface FakeContext {
	/** Current working directory supplied to the tool. */
	readonly cwd: string;
	/** Whether a UI is available for confirmations. */
	readonly hasUI: boolean;
	/** Fake UI methods used by the tool. */
	readonly ui: { readonly confirm: (title: string, message: string) => Promise<boolean> };
}

type ExtensionFactory = (pi: FakePi) => void;

const envRecord = (): Record<string, string | undefined> => processEnv;

const originalEnv = {
	HERDR_ENV: envRecord().HERDR_ENV,
	HERDR_SUBAGENT_NAME: envRecord().HERDR_SUBAGENT_NAME,
	PATH: envRecord().PATH,
	PI_CODING_AGENT_DIR: envRecord().PI_CODING_AGENT_DIR,
	FAKE_HERDR_LOG: envRecord().FAKE_HERDR_LOG,
	FAKE_HERDR_TAB_CLOSE_FAIL: envRecord().FAKE_HERDR_TAB_CLOSE_FAIL,
	FAKE_HERDR_TAB_GET_FAIL: envRecord().FAKE_HERDR_TAB_GET_FAIL,
	FAKE_HERDR_WAIT_HANG: envRecord().FAKE_HERDR_WAIT_HANG,
	FAKE_HERDR_AGENT_STATUS: envRecord().FAKE_HERDR_AGENT_STATUS,
	FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE: envRecord().FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE,
	FAKE_HERDR_PANE_RUN_FAIL: envRecord().FAKE_HERDR_PANE_RUN_FAIL,
	FAKE_HERDR_AGENT_LIST_ENABLE: envRecord().FAKE_HERDR_AGENT_LIST_ENABLE,
	FAKE_HERDR_AGENT_LIST_FAIL: envRecord().FAKE_HERDR_AGENT_LIST_FAIL,
	FAKE_HERDR_AGENT_LIST_TERMINAL_ID: envRecord().FAKE_HERDR_AGENT_LIST_TERMINAL_ID,
	FAKE_HERDR_AGENT_LIST_PANE_ID: envRecord().FAKE_HERDR_AGENT_LIST_PANE_ID,
	FAKE_HERDR_AGENT_LIST_TAB_ID: envRecord().FAKE_HERDR_AGENT_LIST_TAB_ID,
};

let tempRoots: string[] = [];
let loadedTools: LoadedTool[] = [];

/** Restore environment variables and remove temporary roots created by this harness. */
export const cleanupHarness = async (): Promise<void> => {
	for (const loaded of loadedTools) {
		loaded.dispatch("session_shutdown");
	}
	loadedTools = [];
	restoreEnv();
	const roots = tempRoots;
	tempRoots = [];
	for (const root of roots) {
		await rm(root, { recursive: true, force: true });
	}
};

/** Set or unset an environment variable for the current test process. */
export const setEnv = (name: string, value: string | undefined): void => {
	const env = envRecord();
	if (value === undefined) {
		delete env[name];
		return;
	}
	env[name] = value;
};

/** Create a temporary root directory that will be removed by cleanupHarness. */
export const makeTempRoot = async (): Promise<string> => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-subagent-test-"));
	tempRoots.push(root);
	return root;
};

/** Build a fake tool execution context rooted at the provided cwd. */
export const makeContext = (cwd: string): FakeContext => ({
	cwd,
	hasUI: false,
	ui: { confirm: async () => true },
});

/** Load the extension default export and return the captured herdr_subagent tool. */
export const loadToolWithFakePi = async (agentDir: string): Promise<LoadedTool> => {
	setEnv("PI_CODING_AGENT_DIR", agentDir);
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
		dispatch(event) {
			for (const handler of handlers.get(event) ?? []) {
				handler({ type: event });
			}
		},
	};
	loadedTools.push(loaded);
	return loaded;
};

/** Load the extension default export and return the captured herdr_subagent tool. */
export const loadTool = async (agentDir: string): Promise<ToolDefinition> => {
	const loaded = await loadToolWithFakePi(agentDir);
	return loaded.tool;
};

/** Install a fake herdr binary on PATH and return its binary directory and call log path. */
export const installFakeHerdr = async (
	root: string,
): Promise<{ readonly bin: string; readonly log: string }> => {
	const bin = path.join(root, "bin");
	const log = path.join(root, "herdr.log");
	await mkdir(bin, { recursive: true });
	const script = path.join(bin, "herdr");
	await writeFile(script, fakeHerdrScript(), { encoding: "utf8", mode: 0o755 });
	await chmod(script, 0o755);
	setEnv("FAKE_HERDR_LOG", log);
	setEnv("PATH", `${bin}${path.delimiter}${originalEnv.PATH ?? ""}`);
	return { bin, log };
};

/** Read the fake herdr call log as tab-separated argument arrays. */
export const readHerdrCalls = async (log: string): Promise<string[][]> => {
	const text = await readFile(log, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => line.split("\t"));
};

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

/** Return the first pane run command captured from fake herdr calls. */
export const runCommandFromCalls = (
	calls: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined => {
	const runCall = calls.find((args) => args[0] === "pane" && args[1] === "run");
	return runCall?.[3];
};

/** Return the last pane run command captured from fake herdr calls. */
export const lastRunCommandFromCalls = (
	calls: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined => {
	const runCalls = calls.filter((args) => args[0] === "pane" && args[1] === "run");
	return runCalls.at(-1)?.[3];
};

const restoreEnv = (): void => {
	setEnv("HERDR_ENV", originalEnv.HERDR_ENV);
	setEnv("HERDR_SUBAGENT_NAME", originalEnv.HERDR_SUBAGENT_NAME);
	setEnv("PATH", originalEnv.PATH);
	setEnv("PI_CODING_AGENT_DIR", originalEnv.PI_CODING_AGENT_DIR);
	setEnv("FAKE_HERDR_LOG", originalEnv.FAKE_HERDR_LOG);
	setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", originalEnv.FAKE_HERDR_TAB_CLOSE_FAIL);
	setEnv("FAKE_HERDR_TAB_GET_FAIL", originalEnv.FAKE_HERDR_TAB_GET_FAIL);
	setEnv("FAKE_HERDR_WAIT_HANG", originalEnv.FAKE_HERDR_WAIT_HANG);
	setEnv("FAKE_HERDR_AGENT_STATUS", originalEnv.FAKE_HERDR_AGENT_STATUS);
	setEnv(
		"FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE",
		originalEnv.FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE,
	);
	setEnv("FAKE_HERDR_PANE_RUN_FAIL", originalEnv.FAKE_HERDR_PANE_RUN_FAIL);
	setEnv("FAKE_HERDR_AGENT_LIST_ENABLE", originalEnv.FAKE_HERDR_AGENT_LIST_ENABLE);
	setEnv("FAKE_HERDR_AGENT_LIST_FAIL", originalEnv.FAKE_HERDR_AGENT_LIST_FAIL);
	setEnv("FAKE_HERDR_AGENT_LIST_TERMINAL_ID", originalEnv.FAKE_HERDR_AGENT_LIST_TERMINAL_ID);
	setEnv("FAKE_HERDR_AGENT_LIST_PANE_ID", originalEnv.FAKE_HERDR_AGENT_LIST_PANE_ID);
	setEnv("FAKE_HERDR_AGENT_LIST_TAB_ID", originalEnv.FAKE_HERDR_AGENT_LIST_TAB_ID);
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
	const handlers = new Map<SessionEvent, SessionHandler[]>();
	const loaded: LoadedTool = {
		tool: missingTool(message),
		pi,
		sentMessages,
		sentUserMessages,
		dispatch(event) {
			for (const handler of handlers.get(event) ?? []) {
				handler({ type: event });
			}
		},
	};
	loadedTools.push(loaded);
	return loaded;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isExtensionFactory = (value: unknown): value is ExtensionFactory =>
	typeof value === "function";

const fakeHerdrScript = (): string => String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) fs.appendFileSync(log, args.join("\t") + "\n");
const writeJson = (value) => process.stdout.write(JSON.stringify(value));
const argAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const nextAgentStatus = () => {
  let agentStatus = process.env.FAKE_HERDR_AGENT_STATUS || "idle";
  const sequenceFile = process.env.FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE;
  if (sequenceFile && fs.existsSync(sequenceFile)) {
    const statuses = fs.readFileSync(sequenceFile, "utf8").split(/\r?\n/).filter(Boolean);
    if (statuses.length > 0) {
      agentStatus = statuses.shift();
      fs.writeFileSync(sequenceFile, statuses.length > 0 ? statuses.join("\n") + "\n" : "");
    }
  }
  return agentStatus;
};
if (args[0] === "pane" && args[1] === "current") {
  writeJson({ result: { pane: { pane_id: "wTest:p0", terminal_id: "term-root", tab_id: "wTest:t1", workspace_id: "wTest", cwd: "/workspace", foreground_cwd: "/workspace" } } });
  process.exit(0);
}
if (args[0] === "tab" && args[1] === "create") {
  const workspace = argAfter("--workspace") || "wTest";
  const cwd = argAfter("--cwd") || "/workspace";
  const label = argAfter("--label") || "agent: test";
  writeJson({ result: { root_pane: { pane_id: "wTest:p1", terminal_id: "term-subagent", tab_id: "wTest:t2", workspace_id: workspace, cwd, foreground_cwd: cwd }, tab: { tab_id: "wTest:t2", workspace_id: workspace, label } } });
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "run" && process.env.FAKE_HERDR_PANE_RUN_FAIL === "1") {
  process.stderr.write("pane run failed");
  process.exit(1);
}
if (args[0] === "pane" && (args[1] === "rename" || args[1] === "run" || args[1] === "close")) process.exit(0);
if (args[0] === "tab" && args[1] === "close") {
  if (process.env.FAKE_HERDR_TAB_CLOSE_FAIL === "1") {
    process.stderr.write("unknown tab: " + args[2]);
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "tab" && args[1] === "get") {
  if (process.env.FAKE_HERDR_TAB_GET_FAIL === "1") {
    process.stderr.write("unknown tab: " + args[2]);
    process.exit(1);
  }
  writeJson({ result: { tab: { tab_id: args[2], workspace_id: "wTest" } } });
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "get") {
  const agentStatus = nextAgentStatus();
  writeJson({ result: { agent: { pane_id: "wTest:p1", terminal_id: args[2], tab_id: "wTest:t2", workspace_id: "wTest", agent_status: agentStatus, cwd: "/workspace", foreground_cwd: "/workspace" } } });
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "list") {
  if (process.env.FAKE_HERDR_AGENT_LIST_FAIL === "1") {
    process.stderr.write("agent list failed");
    process.exit(1);
  }
  if (process.env.FAKE_HERDR_AGENT_LIST_ENABLE !== "1") {
    writeJson({ result: { agents: [] } });
    process.exit(0);
  }
  const agentStatus = nextAgentStatus();
  writeJson({ result: { agents: [{ pane_id: process.env.FAKE_HERDR_AGENT_LIST_PANE_ID || "wTest:p1", terminal_id: process.env.FAKE_HERDR_AGENT_LIST_TERMINAL_ID || "term-subagent", tab_id: process.env.FAKE_HERDR_AGENT_LIST_TAB_ID || "wTest:t2", workspace_id: "wTest", agent_status: agentStatus, cwd: "/workspace", foreground_cwd: "/workspace" }] } });
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "focus") {
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "read") {
  process.stdout.write("STATUS: done\nAll good.\n");
  process.exit(0);
}
if (args[0] === "wait" && args[1] === "agent-status") {
  if (process.env.FAKE_HERDR_WAIT_HANG === "1") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else {
    process.exit(0);
  }
} else {
  process.stderr.write("unexpected fake herdr call: " + args.join(" "));
  process.exit(2);
}
`;
