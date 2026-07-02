// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
// oxlint-disable effect/no-process-env -- Tests isolate pi/herdr environment variables per case.
// oxlint-disable effect/no-raw-throw -- Test setup fails fast when extension wiring is broken.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

interface ToolResult {
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	readonly details?: unknown;
	readonly isError?: boolean;
}

interface ToolDefinition {
	readonly name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: FakeContext,
	): Promise<ToolResult>;
}

interface FakePi {
	registerTool(tool: ToolDefinition): void;
}

interface FakeContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui: { readonly confirm: (title: string, message: string) => Promise<boolean> };
}

type ExtensionFactory = (pi: FakePi) => void;

const originalEnv = {
	HERDR_ENV: process.env.HERDR_ENV,
	PATH: process.env.PATH,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	FAKE_HERDR_LOG: process.env.FAKE_HERDR_LOG,
	FAKE_HERDR_TAB_CLOSE_FAIL: process.env.FAKE_HERDR_TAB_CLOSE_FAIL,
	FAKE_HERDR_TAB_GET_FAIL: process.env.FAKE_HERDR_TAB_GET_FAIL,
	FAKE_HERDR_WAIT_HANG: process.env.FAKE_HERDR_WAIT_HANG,
};

const restoreEnv = (): void => {
	setEnv("HERDR_ENV", originalEnv.HERDR_ENV);
	setEnv("PATH", originalEnv.PATH);
	setEnv("PI_CODING_AGENT_DIR", originalEnv.PI_CODING_AGENT_DIR);
	setEnv("FAKE_HERDR_LOG", originalEnv.FAKE_HERDR_LOG);
	setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", originalEnv.FAKE_HERDR_TAB_CLOSE_FAIL);
	setEnv("FAKE_HERDR_TAB_GET_FAIL", originalEnv.FAKE_HERDR_TAB_GET_FAIL);
	setEnv("FAKE_HERDR_WAIT_HANG", originalEnv.FAKE_HERDR_WAIT_HANG);
};

const setEnv = (name: string, value: string | undefined): void => {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
};

let tempRoots: string[] = [];

afterEach(async () => {
	restoreEnv();
	const roots = tempRoots;
	tempRoots = [];
	for (const root of roots) {
		await rm(root, { recursive: true, force: true });
	}
});

const makeTempRoot = async (): Promise<string> => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-herdr-subagent-test-"));
	tempRoots.push(root);
	return root;
};

const makeContext = (cwd: string): FakeContext => ({
	cwd,
	hasUI: false,
	ui: { confirm: async () => true },
});

const loadTool = async (agentDir: string): Promise<ToolDefinition> => {
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	const registered: ToolDefinition[] = [];
	const pi: FakePi = {
		registerTool(tool) {
			registered.push(tool);
		},
	};

	const moduleUrl = new URL(`./index.ts?test=${randomUUID()}`, import.meta.url).href;
	const imported: unknown = await import(moduleUrl);
	if (!isRecord(imported)) {
		throw new Error("extension module did not import as an object");
	}
	const factory = imported.default;
	if (!isExtensionFactory(factory)) {
		throw new Error("extension module default export is not a function");
	}
	factory(pi);

	const tool = registered.find((candidate) => candidate.name === "herdr_subagent");
	if (!tool) {
		throw new Error("herdr_subagent tool was not registered");
	}
	return tool;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isExtensionFactory = (value: unknown): value is ExtensionFactory =>
	typeof value === "function";

const installFakeHerdr = async (
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
  writeJson({ result: { agent: { pane_id: "wTest:p1", terminal_id: args[2], tab_id: "wTest:t2", workspace_id: "wTest", agent_status: "idle", cwd: "/workspace", foreground_cwd: "/workspace" } } });
  process.exit(0);
}
if (args[0] === "agent" && (args[1] === "list" || args[1] === "focus")) {
  if (args[1] === "list") writeJson({ result: { agents: [] } });
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

const readHerdrCalls = async (log: string): Promise<string[][]> => {
	const text = await readFile(log, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => line.split("\t"));
};

const writeAgent = async (
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

const runCommandFromCalls = (calls: ReadonlyArray<ReadonlyArray<string>>): string | undefined => {
	const runCall = calls.find((args) => args[0] === "pane" && args[1] === "run");
	return runCall?.[3];
};

const lastRunCommandFromCalls = (
	calls: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined => {
	const runCalls = calls.filter((args) => args[0] === "pane" && args[1] === "run");
	return runCalls.at(-1)?.[3];
};

describe("herdr_subagent extension", () => {
	test("fails before touching herdr when not running inside herdr", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		setEnv("HERDR_ENV", undefined);
		setEnv("PATH", path.join(root, "empty-bin"));
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute("tool-call", { action: "status" }, undefined, undefined, makeContext(root)),
		).rejects.toThrow(/HERDR_ENV is not 1/);
	});

	test("spawns a role with the role's default model", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Implement the focused change.",
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(result.content[0]?.text).toContain("Spawned worker-a");
		const command = runCommandFromCalls(await readHerdrCalls(log));
		expect(command).toContain("--model");
		expect(command).toContain("openai-codex/gpt-5.5");
	});

	test("lets an explicit model override the role default", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "review-a",
				agentType: "worker",
				model: "anthropic/claude-opus-4-8",
				task: "Review the plan for API design issues.",
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const command = runCommandFromCalls(await readHerdrCalls(log));
		expect(command).toContain("anthropic/claude-opus-4-8");
		expect(command).not.toContain("openai-codex/gpt-5.5");
	});

	test("close removes a stale registry entry when the tab is already gone, unblocking the name", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "First task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		// Simulate the user closing the tab manually in herdr: close fails and the tab no longer exists.
		setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", "1");
		setEnv("FAKE_HERDR_TAB_GET_FAIL", "1");

		const closed = await tool.execute(
			"tool-call",
			{ action: "close", target: "worker-a" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(closed.isError).not.toBe(true);
		expect(closed.content[0]?.text).toContain("worker-a");

		setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", undefined);
		setEnv("FAKE_HERDR_TAB_GET_FAIL", undefined);

		const respawned = await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Second task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(respawned.content[0]?.text).toContain("Spawned worker-a");
	});

	test("close by pane id removes the name-keyed registry entry", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "First task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		// Close by the pane id that status/spawn output surfaces, not by registry name.
		const closed = await tool.execute(
			"tool-call",
			{ action: "close", target: "wTest:p1" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(closed.isError).not.toBe(true);

		const respawned = await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Second task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(respawned.content[0]?.text).toContain("Spawned worker-a");
	});

	test("role default thinking is applied and an explicit thinking overrides it", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "planner", "anthropic/claude-opus-4-8", "high");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "plan-a", agentType: "planner", task: "Plan the change." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const defaultCommand = lastRunCommandFromCalls(await readHerdrCalls(log));
		expect(defaultCommand).toContain("--thinking");
		expect(defaultCommand).toContain("'high'");

		await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "plan-b",
				agentType: "planner",
				thinking: "medium",
				task: "Plan the other change.",
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const overriddenCommand = lastRunCommandFromCalls(await readHerdrCalls(log));
		expect(overriddenCommand).toContain("'medium'");
		expect(overriddenCommand).not.toContain("'high'");
	});

	test("a herdr call that ignores SIGTERM is SIGKILLed and reported as a timeout", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_WAIT_HANG", "1");
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "wait", target: "wTest:p1", timeoutMs: 300 },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/timed out/);
	}, 8_000);

	test("close still fails when the tab exists but herdr close fails", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "First task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		// Close fails but the tab still exists: keep the registry entry and reject so
		// the harness marks the tool call as failed.
		setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", "1");

		await expect(
			tool.execute(
				"tool-call",
				{ action: "close", target: "worker-a" },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/herdr exited with code 1/);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Second task." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/already registered/);
	});
});
