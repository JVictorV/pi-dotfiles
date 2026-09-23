import { execFileSync } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
	type WireRequest,
	cleanupHarness,
	installFakeHerdr,
	lastRunCommand,
	loadTool,
	loadToolWithFakePi,
	makeContext,
	makeTempRoot,
	readHerdrRequests,
	firstRunCommand,
	runHerdrSubagentEffect,
	setEnv,
	setSubagentSession,
	writeAgent,
} from "./test-harness";
import type { ModelRegistryForResolution, ResolvableModelEntry } from "./model-resolver";
import { createSubagentNotificationManager } from "./notifications";
import { decodeRegistryEntry } from "./schemas";
import {
	notifySubagentFinished,
	readPublishedResultSocket,
	readSubagentCompletionArm,
	SubagentCompletionDeliveryFailed,
	startSubagentRpcServer,
	takePersistedSubagentCompletion,
	writeSubagentCompletionArm,
} from "./subagent-rpc";

afterEach(cleanupHarness);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const firstMessageContent = (message: unknown): string => {
	if (!isRecord(message)) {
		return "";
	}
	const content = Object.getOwnPropertyDescriptor(message, "content")?.value;
	return typeof content === "string" ? content : "";
};

const firstMessageOptions = (options: unknown): Record<string, unknown> => {
	if (!isRecord(options)) {
		return {};
	}
	return Object.fromEntries(Object.entries(options));
};

const TEST_FRESH_SENT_AT_MS = 4_000_000_000_000;

const modeBits = (mode: number): number => mode & 0o777;

const makeModelRegistry = (
	models: ReadonlyArray<ResolvableModelEntry>,
	available?: ReadonlyArray<ResolvableModelEntry>,
): ModelRegistryForResolution => {
	const base = {
		find(provider: string, modelId: string): ResolvableModelEntry | undefined {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll(): ReadonlyArray<ResolvableModelEntry> {
			return models;
		},
	};
	return available ? { ...base, getAvailable: () => available } : base;
};

const resultSocketArg = (command: string | undefined): string | undefined => {
	const socketPath = command?.match(/HERDR_SUBAGENT_RESULT_SOCK='([^']+)'/u)?.[1];
	return socketPath ? `HERDR_SUBAGENT_RESULT_SOCK=${socketPath}` : undefined;
};

const launchCommands = (calls: ReadonlyArray<WireRequest>): ReadonlyArray<string> =>
	calls
		.filter((request) => request.method === "pane.send_input")
		.map((request) => request.params.text)
		.filter((command): command is string => command !== undefined);

const neverResolvingRunPromise = <A>(): Promise<A> => new Promise<A>(() => {});

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

	test("surfaces protocol mismatch through foreground tool actions", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_PROTOCOL", "20");
		const tool = await loadTool(path.join(root, "agent"));
		const actions = [
			{ action: "status" },
			{ action: "inspect", target: "wTest:p1" },
			{ action: "send", target: "worker-a", message: "Continue." },
			{ action: "wait", target: "worker-a", timeoutMs: 100 },
		] as const;

		for (const params of actions) {
			await expect(
				tool.execute("tool-call", params, undefined, undefined, makeContext(root)),
			).rejects.toThrow(/HerdrUnsupportedProtocol|protocol is unsupported/i);
		}
	});

	test("surfaces malformed SDK responses through the tool boundary", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_MALFORMED_RESPONSE", "1");
		const tool = await loadTool(path.join(root, "agent"));

		await expect(
			tool.execute("tool-call", { action: "status" }, undefined, undefined, makeContext(root)),
		).rejects.toThrow(/HerdrInvalidResponse|invalid response|malformed/i);
	});

	test("model guidance excludes Luna and gates Terra by thinking level", async () => {
		const root = await makeTempRoot();
		const tool = await loadTool(path.join(root, "agent"));
		const guidance = tool.promptGuidelines?.join("\n") ?? "";

		expect(guidance).toContain("Never suggest or select Luna for subagents");
		expect(guidance).toContain("Terra is allowed only with high or xhigh thinking");
		expect(guidance).not.toContain("sol, terra, luna");
	});

	test("denies recursive mutating actions from subagent sessions before herdr calls", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setSubagentSession("worker-a");
		const tool = await loadTool(agentDir);
		const deniedActions = [
			{ action: "spawn", name: "child-a", task: "Delegate this." },
			{ action: "send", target: "worker-b", message: "Continue." },
			{ action: "close", target: "worker-b" },
			{ action: "focus", target: "worker-b" },
		] as const;

		for (const params of deniedActions) {
			await expect(
				tool.execute("tool-call", params, undefined, undefined, makeContext("/workspace")),
			).rejects.toThrow(/STATUS: done or STATUS: blocked.*allowSpawn/);
		}
		expect(readHerdrRequests(log)).toEqual([]);
	});

	test("allows read-only actions from subagent sessions", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		setSubagentSession("worker-a");
		const tool = await loadTool(agentDir);

		const agentTypes = await tool.execute(
			"tool-call-agent-types",
			{ action: "agent-types" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		setEnv("FAKE_HERDR_AGENTS", "none");
		const status = await tool.execute(
			"tool-call-status",
			{ action: "status" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		setEnv("FAKE_HERDR_AGENTS", undefined);
		const inspected = await tool.execute(
			"tool-call-inspect",
			{ action: "inspect", target: "wTest:p1" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const waited = await tool.execute(
			"tool-call-wait",
			{ action: "wait", target: "wTest:p1", timeoutMs: 2_000 },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(agentTypes.content[0]?.text).toContain("No agent types found");
		expect(status.content[0]?.text).toContain("No herdr agents found");
		expect(inspected.content[0]?.text).toContain("STATUS: done");
		expect(waited.content[0]?.text).toContain("finished");
	}, 8_000);

	test("allows spawn from a subagent session with the explicit environment grant", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setSubagentSession("worker-a", true);
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "spawn", name: "child-a", agentType: "worker", task: "Child task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(result.content[0]?.text).toContain("Spawned child-a");
	});

	test("spawn sends protocol 21 requests with SDK wire parameters", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Wire task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const requests = readHerdrRequests(log);
		expect(requests[0]?.method).toBe("ping");
		expect(requests.find((request) => request.method === "pane.current")?.params).toEqual({
			caller_pane_id: "wTest:p0",
		});
		expect(requests.find((request) => request.method === "tab.create")?.params).toMatchObject({
			workspace_id: "wTest",
			cwd: "/workspace",
			label: "agent: worker-a",
			focus: false,
		});
		const input = requests.find((request) => request.method === "pane.send_input");
		expect(input?.params).toMatchObject({ pane_id: "wTest:p1", keys: ["Enter"] });
		expect(input?.params.text).toContain("pi");
	});

	test("spawn records the current pane as the registry owner", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Owned task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const registryText = await readFile(
			path.join(agentDir, "herdr-subagents", "registry", "worker-a.json"),
			"utf8",
		);
		expect(registryText).toContain('"ownerPaneId": "wTest:p0"');
	});

	test("spawn allowSpawn parameter controls the child recursion grant env", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call-default",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Default task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await tool.execute(
			"tool-call-allow",
			{
				action: "spawn",
				name: "worker-b",
				agentType: "worker",
				task: "Allowed task.",
				allowSpawn: true,
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const commands = launchCommands(readHerdrRequests(log));
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN='0'");
		expect(commands[1]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN='1'");
	});

	test("launch shell preserves child environment names and values", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Record the launch environment.",
				allowSpawn: true,
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const command = firstRunCommand(readHerdrRequests(log));
		expect(command).toBeDefined();
		if (!command) return;

		const bin = path.join(root, "launch-bin");
		const record = path.join(root, "launch-env.txt");
		const fakePi = path.join(bin, "pi");
		await mkdir(bin, { recursive: true });
		await writeFile(
			fakePi,
			'#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$HERDR_SUBAGENT_NAME" "$HERDR_SUBAGENT_ALLOW_SPAWN" "$HERDR_SUBAGENT_RESULT_SOCK" > "$RECORD"\n',
			"utf8",
		);
		await chmod(fakePi, 0o755);
		execFileSync("sh", ["-c", command], {
			cwd: root,
			env: {
				...process.env,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				RECORD: record,
			},
		});

		const [name, allowSpawn, resultSocket] = (await readFile(record, "utf8")).trim().split("\n");
		expect(name).toBe("worker-a");
		expect(allowSpawn).toBe("1");
		expect(resultSocket).toMatch(/\.sock$/u);
	});

	test("agent frontmatter allowSpawn grants child recursion unless a param overrides it", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		const agentsDir = path.join(agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(
			path.join(agentsDir, "delegator.md"),
			"---\nname: delegator\ndescription: can delegate\nmodel: openai-codex/gpt-5.6-sol\nallowSpawn: true\n---\n\nYou may delegate.\n",
			"utf8",
		);
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call-frontmatter",
			{ action: "spawn", name: "delegator-a", agentType: "delegator", task: "Task A." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await tool.execute(
			"tool-call-override",
			{
				action: "spawn",
				name: "delegator-b",
				agentType: "delegator",
				task: "Task B.",
				allowSpawn: false,
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const commands = launchCommands(readHerdrRequests(log));
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN='1'");
		expect(commands[1]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN='0'");
	});

	test("registry names resolve stable terminals before controlling moved panes", async () => {
		const root = await makeTempRoot();
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_LIST_PANE_ID", "wMoved:p9");
		const tool = await loadTool(path.join(root, "agent"));
		const ctx = makeContext(root);
		await tool.execute(
			"spawn",
			{
				action: "spawn",
				name: "moved-worker",
				task: "Inspect the code.",
				notify: false,
			},
			undefined,
			undefined,
			ctx,
		);

		const inspected = await tool.execute(
			"inspect",
			{
				action: "inspect",
				target: "moved-worker",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(inspected.content[0]?.text).toContain("All good.");
		await tool.execute(
			"send",
			{
				action: "send",
				target: "moved-worker",
				message: "Continue.",
				notify: false,
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"focus",
			{
				action: "focus",
				target: "moved-worker",
			},
			undefined,
			undefined,
			ctx,
		);

		const requests = readHerdrRequests(log);
		expect(requests.find((request) => request.method === "pane.read")?.params.pane_id).toBe(
			"wMoved:p9",
		);
		expect(
			requests.find(
				(request) => request.method === "pane.send_input" && request.params.text === "Continue.",
			)?.params.pane_id,
		).toBe("wMoved:p9");
		expect(requests.find((request) => request.method === "agent.focus")?.params.target).toBe(
			"wMoved:p9",
		);
	});

	test("missing agents do not resolve registry names or unknown terminal ids", async () => {
		const root = await makeTempRoot();
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(path.join(root, "agent"));
		const ctx = makeContext(root);
		await tool.execute(
			"spawn",
			{ action: "spawn", name: "gone-worker", task: "Inspect.", notify: false },
			undefined,
			undefined,
			ctx,
		);
		await expect(
			tool.execute(
				"send",
				{ action: "send", target: "term-unknown", message: "Do not send." },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/Could not resolve subagent or pane target/);
		setEnv("FAKE_HERDR_AGENTS", "none");
		const status = await tool.execute("status", { action: "status" }, undefined, undefined, ctx);
		expect(status.content[0]?.text).toContain("missing");
		for (const target of ["gone-worker", "term-subagent"]) {
			await expect(
				tool.execute(
					"send",
					{ action: "send", target, message: "Do not send." },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/Could not resolve subagent or pane target/);
		}
		expect(
			readHerdrRequests(log).some(
				(request) => request.method === "pane.send_input" && request.params.text === "Do not send.",
			),
		).toBe(false);
	});

	test("a canceled project spawn releases its notification batch reservation", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(path.join(root, ".pi"), "project-worker", "openai-codex/gpt-6-astra");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const loaded = await loadToolWithFakePi(agentDir);
		const canceled = await loaded.tool.execute(
			"cancel",
			{
				action: "spawn",
				name: "canceled-worker",
				agentType: "project-worker",
				agentScope: "project",
				task: "Inspect.",
			},
			undefined,
			undefined,
			{
				...makeContext(root),
				hasUI: true,
				ui: { confirm: async () => false },
			},
		);
		expect(canceled.content[0]?.text).toContain("Canceled:");
		expect(canceled.details).toEqual({
			action: "spawn",
			projectAgentsDir: path.join(root, ".pi", "agents"),
		});
		expect(readHerdrRequests(log)).toEqual([]);
		await loaded.tool.execute(
			"spawn",
			{ action: "spawn", name: "approved-worker", task: "Inspect." },
			undefined,
			undefined,
			makeContext(root),
		);
		const socketPath =
			resultSocketArg(firstRunCommand(readHerdrRequests(log)))?.replace(
				"HERDR_SUBAGENT_RESULT_SOCK=",
				"",
			) ?? "";
		const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("approved-worker"));
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "approved-worker",
				status: "done",
				finalMessage: "Finished the approved work.",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				armId,
			}),
		);
		await vi.waitFor(() => expect(loaded.sentMessages).toHaveLength(1), { timeout: 3_000 });
		expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain(
			"Finished the approved work.",
		);
	});

	test("plain spawns use GPT-6 Astra instead of inheriting pi's default model", async () => {
		const root = await makeTempRoot();
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(path.join(root, "agent"));

		await tool.execute(
			"tool-call",
			{ action: "spawn", name: "plain-worker", task: "Inspect the code.", notify: false },
			undefined,
			undefined,
			makeContext(root),
		);

		expect(firstRunCommand(readHerdrRequests(log))).toContain(
			"'--model' 'openai-codex/gpt-6-astra'",
		);
	});

	test("spawns a role with the role's default model", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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
		const command = firstRunCommand(readHerdrRequests(log));
		expect(command).toContain("--model");
		expect(command).toContain("openai-codex/gpt-5.6-sol");
	});

	test("spawn uses the settled outbox when the live result socket is unavailable", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\ndone\nworking\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Implement the focused change and report the result.",
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 2_500);
		});
		expect(loaded.sentMessages).toHaveLength(0);

		const launchCommand = firstRunCommand(readHerdrRequests(log));
		const socketArg = resultSocketArg(launchCommand);
		expect(socketArg).toBeDefined();
		const socketPath = socketArg?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";
		const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
		expect(armId).toMatch(/^[0-9a-f-]{36}$/u);
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "the final settled result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				armId,
			}),
		);

		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 3_000, interval: 50 },
		);
		const delivered = loaded.sentMessages[0];
		const content = firstMessageContent(delivered?.message);
		expect(firstMessageOptions(delivered?.options)).toEqual({
			deliverAs: "steer",
			triggerTurn: true,
		});
		expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
		expect(content).toContain("Subagent worker-a finished");
		expect(content).toContain("Implement the focused change");
		expect(content).toContain("the final settled result");
		expect(content).not.toContain('<required_action tool="herdr_subagent" action="inspect"');
		expect(content).toContain("<final_message>");
	}, 8_000);

	test("blocked watcher notifications distinguish attention-needed state", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		// Realistic pickup: working phase first, then the blocked state is trusted immediately.
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\nblocked\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "blocked");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Find the blocker." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 6_000, interval: 50 },
		);
		const content = firstMessageContent(loaded.sentMessages[0]?.message);
		expect(content).toContain('state="blocked"');
		expect(content).toContain("Subagent worker-a needs attention");
		expect(content).toContain("use herdr_subagent send or focus to unblock");
	});

	test("explicit wait consumes an armed watcher without a duplicate notification", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await loaded.tool.execute(
			"tool-call-wait",
			{ action: "wait", target: "worker-a", timeoutMs: 2_000 },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 150);
		});
		expect(loaded.sentMessages).toHaveLength(0);
	}, 8_000);

	test("close cancels an armed watcher", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await loaded.tool.execute(
			"tool-call-close",
			{ action: "close", target: "worker-a" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 150);
		});
		expect(loaded.sentMessages).toHaveLength(0);
	});

	test("send replaces a live watcher and delivers exactly one settled result", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Initial task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "worker-a", message: "Follow-up after spawn." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const launchCommand = firstRunCommand(readHerdrRequests(log));
		const socketPath =
			resultSocketArg(launchCommand)?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";
		const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "the settled follow-up result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				armId,
			}),
		);

		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 4_000, interval: 50 },
		);
		const content = firstMessageContent(loaded.sentMessages[0]?.message);
		expect(content).toContain("Follow-up after spawn.");
		expect(content).toContain("the settled follow-up result");
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 2_200);
		});
		expect(loaded.sentMessages).toHaveLength(1);
	}, 8_000);

	test("send re-arm distrusts the previous turn's leftover done status", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Initial task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		// The production race: after a send, the pane still reports the PREVIOUS turn's done
		// because the subagent has not picked the message up yet. The re-armed watcher must not
		// deliver a stale notification from that leftover status.
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "worker-a", message: "Follow-up after spawn." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		// Well inside the startup-stability window: nothing may fire on the leftover done.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5_000);
		});
		expect(loaded.sentMessages).toHaveLength(0);
	}, 10_000);

	test("a direct RPC watcher ignores transient done until the settled result arrives", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\ndone\nworking\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		try {
			const directNotification = {
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "Task A.",
				completionSource: "rpc" as const,
			};
			manager.arm(directNotification);

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 2_500);
			});
			expect(sentMessages).toHaveLength(0);

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "the settled result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(1);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain("the settled result");
		} finally {
			manager.cancelAll();
		}
	}, 8_000);

	test("send to a live pane does not trust transient terminal status", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const statusSequence = path.join(root, "status-sequence.txt");
		// Pane resolution consumes the first status. The watcher then sees working, done, working.
		await writeFile(statusSequence, "working\nworking\ndone\nworking\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		const sendResult = await loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "wTest:p1", message: "Follow-up to live pane." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(sendResult.content.at(-1)?.text).toContain(
			"Automatic settled-result delivery is unavailable",
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 2_500);
		});

		expect(loaded.sentMessages).toHaveLength(0);
	}, 8_000);

	test("a direct RPC watcher still reports a blocked subagent", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\nblocked\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "blocked");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		try {
			const directNotification = {
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "Task A.",
				completionSource: "rpc" as const,
			};
			manager.arm(directNotification);

			await vi.waitFor(
				() => {
					expect(sentMessages).toHaveLength(1);
				},
				{ timeout: 5_000, interval: 50 },
			);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain('state="blocked"');
		} finally {
			manager.cancelAll();
		}
	}, 8_000);

	test("session shutdown cancels pending watchers", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		loaded.dispatch("session_shutdown");
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 2_200);
		});
		expect(loaded.sentMessages).toHaveLength(0);
	}, 8_000);

	test("notify false disables spawn watcher delivery", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Task A.",
				notify: false,
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 150);
		});
		expect(loaded.sentMessages).toHaveLength(0);
	});

	test("solo RPC completion keeps the existing individual notification envelope", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "solo result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(1);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
			expect(content).toContain("solo result");
			expect(content).not.toContain("<subagent_result_group");
		} finally {
			manager.cancelAll();
		}
	});

	test("a fast new settlement is buffered while the previous watcher is still armed", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "old action",
				expectedArmId: "arm-old",
				acceptResultsSinceMs: 0,
			});
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "fast new result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-new",
				armId: "arm-new",
			});
			expect(sentMessages).toHaveLength(0);

			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "new action",
				expectedArmId: "arm-new",
				acceptResultsSinceMs: 0,
			});

			expect(sentMessages).toHaveLength(1);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain("fast new result");
		} finally {
			manager.cancelAll();
		}
	});

	test("a late previous settlement cannot consume a newly armed action", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "new action",
				expectedArmId: "arm-new",
				acceptResultsSinceMs: 0,
			});
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "previous result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-old",
				armId: "arm-old",
			});
			expect(sentMessages).toHaveLength(0);

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "new result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-new",
				armId: "arm-new",
			});

			expect(sentMessages).toHaveLength(1);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain("new result");
		} finally {
			manager.cancelAll();
		}
	});

	test("a watcher accepts the arm from a send whose SDK response failed", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "original action",
				expectedArmId: "arm-original",
				acceptResultsSinceMs: 0,
			});
			manager.acceptArm("worker-a", "arm-attempted");
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "the attempted send was accepted",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-attempted",
				armId: "arm-attempted",
			});

			expect(sentMessages).toHaveLength(1);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain(
				"the attempted send was accepted",
			);
		} finally {
			manager.cancelAll();
		}
	});

	test("distinct settlements with the same report each notify exactly once", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "same final report",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-1",
			});
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task B." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "same final report",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-2",
			});

			expect(sentMessages).toHaveLength(2);
		} finally {
			manager.cancelAll();
		}
	});

	test("a repeated completion id is dropped without consuming the fresh watcher", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "first report",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-1",
			});
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task B." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "first report",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-1",
			});
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "second report",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-2",
			});

			expect(sentMessages).toHaveLength(2);
			expect(firstMessageContent(sentMessages[1]?.message)).toContain("second report");
		} finally {
			manager.cancelAll();
		}
	});

	test("a completion that arrives before arm is delivered after the reservation attaches", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.beginBatchMember("worker-a");
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "fast result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-fast",
			});
			expect(sentMessages).toHaveLength(0);

			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "Task A.",
				acceptResultsSinceMs: 0,
			});

			expect(sentMessages).toHaveLength(1);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain("fast result");
		} finally {
			manager.cancelAll();
		}
	});

	test("RPC completions reserved in the same spawn dispatch batch are joined after async arm I/O", async () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
			{ armBatchWindowMs: 1 },
		);
		try {
			manager.beginBatchMember("worker-a");
			manager.beginBatchMember("worker-b");
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5);
			});
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5);
			});
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B." });

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "result A",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});
			expect(sentMessages).toHaveLength(0);

			manager.deliverExternal("worker-b", {
				status: "blocked",
				finalMessage: "result B",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(1);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain(
				'<subagent_result_group state="complete" partial="false" delivered="2" pending="0">',
			);
			expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
			expect(content).toContain(
				'<subagent_result name="worker-b" state="blocked" pane="wTest:p2">',
			);
			expect(content).toContain("result A");
			expect(content).toContain("result B");
			expect(firstMessageOptions(sentMessages[0]?.options)).toEqual({
				deliverAs: "steer",
				triggerTurn: true,
			});
		} finally {
			manager.cancelAll();
		}
	});

	test("spawn failure releases its batch reservation instead of waiting on a ghost member", () => {
		vi.useFakeTimers();
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.beginBatchMember("worker-a");
			manager.beginBatchMember("worker-b");
			vi.advanceTimersByTime(150);
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "result A",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});
			expect(sentMessages).toHaveLength(0);

			manager.releaseBatchMember("worker-b");

			expect(sentMessages).toHaveLength(1);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
			expect(content).toContain("result A");
			expect(content).not.toContain("<subagent_result_group");
		} finally {
			manager.cancelAll();
			vi.useRealTimers();
		}
	});

	test("cancelAll clears duplicate RPC fingerprints for future sessions", () => {
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "same result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});
			manager.cancelAll();
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task B." });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "same result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(2);
		} finally {
			manager.cancelAll();
		}
	});

	test("group join timeout sends partial batches and re-batches stragglers", () => {
		vi.useFakeTimers();
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B." });
			manager.arm({ name: "worker-c", paneId: "wTest:p3", summarySource: "Task C." });

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "result A",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});
			vi.advanceTimersByTime(29_999);
			expect(sentMessages).toHaveLength(0);
			vi.advanceTimersByTime(1);

			expect(sentMessages).toHaveLength(1);
			const firstContent = firstMessageContent(sentMessages[0]?.message);
			expect(firstContent).toContain(
				'<subagent_result_group state="partial" partial="true" delivered="1" pending="2">',
			);
			expect(firstContent).toContain("result A");
			expect(firstContent).not.toContain("result B");

			manager.deliverExternal("worker-b", {
				status: "done",
				finalMessage: "result B",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});
			vi.advanceTimersByTime(14_999);
			expect(sentMessages).toHaveLength(1);
			vi.advanceTimersByTime(1);

			expect(sentMessages).toHaveLength(2);
			const secondContent = firstMessageContent(sentMessages[1]?.message);
			expect(secondContent).toContain(
				'<subagent_result_group state="partial" partial="true" delivered="1" pending="1">',
			);
			expect(secondContent).toContain("result B");
			expect(secondContent).not.toContain("result C");

			manager.deliverExternal("worker-c", {
				status: "done",
				finalMessage: "result C",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(3);
			const thirdContent = firstMessageContent(sentMessages[2]?.message);
			expect(thirdContent).toContain(
				'<subagent_result_group state="complete" partial="false" delivered="1" pending="0">',
			);
			expect(thirdContent).toContain("result C");
		} finally {
			manager.cancelAll();
			vi.useRealTimers();
		}
	});

	test("cancel removes a completed member that is waiting for its group", () => {
		vi.useFakeTimers();
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			neverResolvingRunPromise,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A." });
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B." });
			vi.advanceTimersByTime(150);
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "result A",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-a",
			});
			expect(sentMessages).toHaveLength(0);

			manager.cancel("worker-a");
			manager.deliverExternal("worker-b", {
				status: "done",
				finalMessage: "result B",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-b",
			});

			expect(sentMessages).toHaveLength(1);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain("result B");
			expect(content).not.toContain("result A");
		} finally {
			manager.cancelAll();
			vi.useRealTimers();
		}
	});

	test("stale RPC after re-arm is dropped and the fresh watcher remains armed", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "old task" });
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "new task" });

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "old result",
				sentAtMs: 0,
			});
			expect(sentMessages).toHaveLength(0);

			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "fresh result",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
			});

			expect(sentMessages).toHaveLength(1);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain("fresh result");
			expect(content).not.toContain("old result");
		} finally {
			manager.cancelAll();
		}
	}, 8_000);

	test("a subagent sends only the final assistant report after Pi settles", async () => {
		const root = await makeTempRoot();
		const socketPath = path.join(root, "result.sock");
		const received: Array<{
			readonly finalMessage: string;
			readonly status: string;
			readonly armId?: string;
		}> = [];
		const server = await runHerdrSubagentEffect(
			startSubagentRpcServer({
				socketPath,
				onFinished(payload) {
					received.push({
						finalMessage: payload.finalMessage,
						status: payload.status,
						armId: payload.armId,
					});
				},
			}),
		);
		try {
			setEnv("HERDR_ENV", "1");
			setSubagentSession("worker-a");
			setEnv("HERDR_SUBAGENT_RESULT_SOCK", socketPath);
			const loaded = await loadToolWithFakePi(path.join(root, "agent"));
			const assistantMessage = (text: string, stopReason: "length" | "stop") => ({
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
			});

			await runHerdrSubagentEffect(writeSubagentCompletionArm("worker-a", "arm-length"));
			await loaded.dispatchAsync("agent_start");
			loaded.dispatch("agent_end", {
				messages: [assistantMessage("premature length-limited report", "length")],
			});
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			expect(received).toHaveLength(0);

			await runHerdrSubagentEffect(writeSubagentCompletionArm("worker-a", "arm-reset"));
			await loaded.dispatchAsync("agent_start");
			loaded.dispatch("agent_end", {
				messages: [
					{
						role: "assistant",
						stopReason: "toolUse",
						content: [
							{ type: "text", text: "I will reset context and continue the task." },
							{ type: "toolCall", id: "reset-context", name: "new_context", arguments: {} },
						],
					},
				],
			});
			await loaded.dispatchAsync("agent_settled");
			expect(received).toHaveLength(0);

			await runHerdrSubagentEffect(writeSubagentCompletionArm("worker-a", "arm-done"));
			await loaded.dispatchAsync("agent_start");
			await runHerdrSubagentEffect(writeSubagentCompletionArm("worker-a", "arm-steered"));
			await loaded.dispatchAsync("input", { source: "interactive", text: "steer" });
			const doneReport = "STATUS: blocked\nSTATUS: done";
			loaded.dispatch("agent_end", {
				messages: [assistantMessage(doneReport, "stop")],
			});
			expect(received).toHaveLength(0);

			loaded.dispatch("agent_settled");
			await vi.waitFor(
				() => {
					expect(received).toEqual([
						{ finalMessage: doneReport, status: "done", armId: "arm-steered" },
					]);
				},
				{ timeout: 1_500, interval: 10 },
			);

			await runHerdrSubagentEffect(writeSubagentCompletionArm("worker-a", "arm-blocked"));
			await loaded.dispatchAsync("agent_start");
			loaded.dispatch("agent_end", {
				messages: [assistantMessage("STATUS: blocked\nI need a credential.", "stop")],
			});
			loaded.dispatch("agent_settled");
			await vi.waitFor(
				() => {
					expect(received).toEqual([
						{ finalMessage: doneReport, status: "done", armId: "arm-steered" },
						{
							finalMessage: "STATUS: blocked\nI need a credential.",
							status: "blocked",
							armId: "arm-blocked",
						},
					]);
				},
				{ timeout: 1_500, interval: 10 },
			);
		} finally {
			await server.close();
		}
	}, 8_000);

	test("RPC result delivery uses the actual final message and consumes the watcher", async () => {
		const root = await makeTempRoot();
		const socketPath = path.join(root, "result.sock");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		const server = await runHerdrSubagentEffect(
			startSubagentRpcServer({
				socketPath,
				onFinished(payload) {
					manager.deliverExternal(payload.name, {
						status: payload.status,
						finalMessage: payload.finalMessage,
						sentAtMs: payload.sentAtMs,
					});
				},
			}),
		);
		try {
			manager.arm({
				name: "worker-a",
				paneId: "wTest:p1",
				summarySource: "Task A.",
			});

			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath,
					name: "worker-a",
					status: "done",
					finalMessage: "the actual result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
				}),
			);

			await vi.waitFor(
				() => {
					expect(sentMessages).toHaveLength(1);
				},
				{ timeout: 1_000, interval: 10 },
			);
			const content = firstMessageContent(sentMessages[0]?.message);
			expect(content).toContain("<final_message>\nthe actual result\n</final_message>");
			expect(content).not.toContain("<pane_tail>");

			setEnv("FAKE_HERDR_AGENT_STATUS", "done");
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 2_200);
			});
			expect(sentMessages).toHaveLength(1);
		} finally {
			manager.cancelAll();
			await server.close();
		}
	}, 8_000);

	test("RPC result delivery without an armed watcher does not notify", async () => {
		const root = await makeTempRoot();
		const socketPath = path.join(root, "result.sock");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		const server = await runHerdrSubagentEffect(
			startSubagentRpcServer({
				socketPath,
				onFinished(payload) {
					manager.deliverExternal(payload.name, {
						status: payload.status,
						finalMessage: payload.finalMessage,
						sentAtMs: payload.sentAtMs,
					});
				},
			}),
		);
		try {
			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath,
					name: "worker-a",
					status: "done",
					finalMessage: "the actual result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
				}),
			);

			expect(sentMessages).toHaveLength(0);
		} finally {
			manager.cancelAll();
			await server.close();
		}
	});

	test("a failed result RPC falls back to the durable settled result", async () => {
		const root = await makeTempRoot();
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			runHerdrSubagentEffect,
		);
		try {
			manager.arm({
				name: "worker-durable",
				paneId: "wTest:p1",
				summarySource: "Task A.",
				completionSource: "rpc",
				acceptResultsSinceMs: 0,
			});
			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath: path.join(root, "missing.sock"),
					name: "worker-durable",
					status: "done",
					finalMessage: "durable fallback result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
					completionId: "completion-durable",
				}),
			);
			const completionDir = path.join(root, "agent", "herdr-subagents", "completion");
			const completionFile = (await readdir(completionDir)).find(
				(fileName) => fileName.startsWith("v2-worker-durable-") && fileName.endsWith(".json"),
			);
			expect(completionFile).toBeDefined();
			expect(modeBits((await stat(completionDir)).mode)).toBe(0o700);
			if (completionFile) {
				expect(modeBits((await stat(path.join(completionDir, completionFile))).mode)).toBe(0o600);
			}

			await vi.waitFor(
				() => {
					expect(sentMessages).toHaveLength(1);
				},
				{ timeout: 5_000, interval: 50 },
			);
			expect(firstMessageContent(sentMessages[0]?.message)).toContain("durable fallback result");
		} finally {
			manager.cancelAll();
		}
	}, 8_000);

	test("durable fallback retains more than one undelivered settlement", async () => {
		const root = await makeTempRoot();
		setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
		for (const [index, completionId] of ["completion-1", "completion-2"].entries()) {
			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath: path.join(root, "missing.sock"),
					name: "worker-queued",
					status: "done",
					finalMessage: `result ${index + 1}`,
					sentAtMs: index + 1,
					completionId,
				}),
			);
		}

		const first = await runHerdrSubagentEffect(takePersistedSubagentCompletion("worker-queued"));
		const second = await runHerdrSubagentEffect(takePersistedSubagentCompletion("worker-queued"));

		expect(first?.completionId).toBe("completion-1");
		expect(second?.completionId).toBe("completion-2");
	});

	test("RPC client degrades quickly when the orchestrator socket is unavailable", async () => {
		const root = await makeTempRoot();
		setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
		const outcome = await Promise.race([
			runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath: path.join(root, "missing.sock"),
					name: "worker-a",
					status: "done",
					finalMessage: "the actual result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
				}),
			).then(() => "resolved" as const),
			new Promise<"timed-out">((resolve) => {
				setTimeout(() => resolve("timed-out"), 1_000);
			}),
		]);

		expect(outcome).toBe("resolved");
	});

	test("completion delivery fails when neither RPC nor durable persistence succeeds", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		setEnv("PI_CODING_AGENT_DIR", agentDir);
		const runtimeDir = path.join(agentDir, "herdr-subagents");
		await mkdir(runtimeDir, { recursive: true });
		await writeFile(path.join(runtimeDir, "completion"), "not a directory", "utf8");

		await expect(
			runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath: path.join(root, "missing.sock"),
					name: "worker-undelivered",
					status: "done",
					finalMessage: "the undeliverable result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
				}),
			),
		).rejects.toBeInstanceOf(SubagentCompletionDeliveryFailed);
	});

	test("server close after restart does not unlink the new server socket", async () => {
		const root = await mkdtemp(path.join("/tmp", "pi-hsa-rpc-"));
		try {
			const agentDir = path.join(root, "agent");
			setEnv("PI_CODING_AGENT_DIR", agentDir);
			let received = 0;
			const first = await runHerdrSubagentEffect(
				startSubagentRpcServer({ ownerId: "same-owner", onFinished() {} }),
			);
			const second = await runHerdrSubagentEffect(
				startSubagentRpcServer({
					ownerId: "same-owner",
					onFinished() {
						received += 1;
					},
				}),
			);
			try {
				expect(second.socketPath).not.toBe(first.socketPath);
				await first.close();
				await access(second.socketPath);
				await runHerdrSubagentEffect(
					notifySubagentFinished({
						socketPath: second.socketPath,
						name: "worker-a",
						status: "done",
						finalMessage: "still connected",
						sentAtMs: TEST_FRESH_SENT_AT_MS,
					}),
				);
				await vi.waitFor(() => {
					expect(received).toBe(1);
				});
			} finally {
				await second.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("starting another RPC server preserves an old active socket", async () => {
		const root = await mkdtemp(path.join("/tmp", "pi-hsa-rpc-"));
		try {
			const agentDir = path.join(root, "agent");
			setEnv("PI_CODING_AGENT_DIR", agentDir);
			let received = 0;
			const first = await runHerdrSubagentEffect(
				startSubagentRpcServer({
					onFinished() {
						received += 1;
					},
				}),
			);
			const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
			await utimes(first.socketPath, oldTimestamp, oldTimestamp);
			const second = await runHerdrSubagentEffect(startSubagentRpcServer({ onFinished() {} }));
			try {
				await access(first.socketPath);
				await runHerdrSubagentEffect(
					notifySubagentFinished({
						socketPath: first.socketPath,
						name: "worker-a",
						status: "done",
						finalMessage: "still connected",
						sentAtMs: TEST_FRESH_SENT_AT_MS,
					}),
				);
				await vi.waitFor(() => {
					expect(received).toBe(1);
				});
			} finally {
				await first.close();
				await second.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("RPC directory and socket permissions are owner-only", async () => {
		const root = await mkdtemp(path.join("/tmp", "pi-hsa-rpc-"));
		try {
			const agentDir = path.join(root, "agent");
			setEnv("PI_CODING_AGENT_DIR", agentDir);
			const server = await runHerdrSubagentEffect(startSubagentRpcServer({ onFinished() {} }));
			try {
				expect(modeBits((await stat(path.dirname(server.socketPath))).mode)).toBe(0o700);
				expect(modeBits((await stat(server.socketPath)).mode)).toBe(0o600);
			} finally {
				await server.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("spawn passes a durable fallback path before the live RPC server is available", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-hsa-"));
		try {
			const agentDir = path.join(root, "agent");
			await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
			const { log } = await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			setEnv("FAKE_HERDR_AGENT_STATUS", "working");
			const loaded = await loadToolWithFakePi(agentDir);

			await loaded.tool.execute(
				"tool-call-no-rpc",
				{
					action: "spawn",
					name: "worker-a",
					agentType: "worker",
					task: "Task A.",
					notify: false,
				},
				undefined,
				undefined,
				makeContext("/workspace"),
			);

			loaded.dispatch("session_start", { type: "session_start" }, { mode: "print", hasUI: false });
			const rpcDir = path.join(agentDir, "herdr-subagents", "rpc");
			await vi.waitFor(
				async () => {
					const sockets = await readdir(rpcDir);
					expect(sockets.some((name) => name.startsWith("v1-") && name.endsWith(".sock"))).toBe(
						true,
					);
				},
				{ timeout: 1_000, interval: 10 },
			);

			await loaded.tool.execute(
				"tool-call-with-rpc",
				{ action: "spawn", name: "worker-b", agentType: "worker", task: "Task B." },
				undefined,
				undefined,
				makeContext("/workspace"),
			);

			const commands = launchCommands(readHerdrRequests(log));
			expect(commands).toHaveLength(2);
			const fallbackSocketArg = resultSocketArg(commands[0]);
			expect(fallbackSocketArg).toBeDefined();
			const socketArg = resultSocketArg(commands[1]);
			expect(socketArg).toBeDefined();
			expect(socketArg).not.toBe(fallbackSocketArg);
			const socketPath = socketArg?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";
			await access(socketPath);
			const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-b"));
			expect(armId).toMatch(/^[0-9a-f-]{36}$/u);

			setEnv("FAKE_HERDR_AGENT_STATUS", "done");
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 2_500);
			});
			expect(loaded.sentMessages).toHaveLength(0);

			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath,
					name: "worker-b",
					status: "done",
					finalMessage: "the settled direct result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
					armId,
				}),
			);
			await vi.waitFor(
				() => {
					expect(loaded.sentMessages).toHaveLength(1);
				},
				{ timeout: 1_000, interval: 10 },
			);
			expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain(
				"the settled direct result",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 8_000);

	const writeOrphanedRegistryEntry = async (registryDir: string): Promise<void> => {
		await mkdir(registryDir, { recursive: true });
		await writeFile(
			path.join(registryDir, "worker-a.json"),
			`${JSON.stringify(
				{
					name: "worker-a",
					phase: "active",
					ownerPaneId: "wTest:p0",
					target: "term-subagent",
					paneId: "wTest:p1",
					terminalId: "term-subagent",
					tabId: "wTest:t2",
					workspaceId: "wTest",
					cwd: "/workspace",
					label: "agent: worker-a",
					taskFile: "/task-worker-a.md",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	};

	// Unix sockets cannot exceed the ~107-char path limit, so these tests use short /tmp roots
	// instead of makeTempRoot (whose $TMPDIR base makes rpc socket paths too long to bind).
	test("a reopened orchestrator adopts orphaned subagents and resumed children redeliver results", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-hsa-r-"));
		try {
			const agentDir = path.join(root, "agent");
			await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			setEnv("FAKE_HERDR_AGENT_STATUS", "working");
			setSubagentSession(undefined);
			const runtimeDir = path.join(agentDir, "herdr-subagents");
			await writeOrphanedRegistryEntry(path.join(runtimeDir, "registry"));

			// Reopened orchestrator session: fresh process, no spawn-time env anywhere.
			const parent = await loadToolWithFakePi(agentDir);
			await parent.dispatchAsync(
				"session_start",
				{ type: "session_start" },
				{ mode: "print", hasUI: false },
			);
			let publishedSocketPath = "";
			await vi.waitFor(
				async () => {
					const socketPath = await runHerdrSubagentEffect(readPublishedResultSocket("wTest:p0"));
					expect(socketPath).toBeDefined();
					publishedSocketPath = socketPath ?? "";
					expect(publishedSocketPath).toMatch(/\.sock$/u);
				},
				{ timeout: 2_000, interval: 10 },
			);
			await access(publishedSocketPath);

			// Seeded ownership keeps automatic delivery available without a fresh spawn.
			const sendResult = await parent.tool.execute(
				"tool-call-send",
				{ action: "send", target: "worker-a", message: "Continue after the restart." },
				undefined,
				undefined,
				makeContext("/workspace"),
			);
			const sendText = sendResult.content.map((part) => part.text).join("");
			expect(sendText).not.toContain("Automatic settled-result delivery is unavailable");

			// Herdr still identifies the pane when the subagent resumes with pi --session.
			setEnv("FAKE_HERDR_PANE_CURRENT_PANE_ID", "wTest:p1");
			setEnv("FAKE_HERDR_PANE_CURRENT_TERMINAL_ID", "term-subagent");
			setEnv("HERDR_PANE_ID", "wTest:p1");
			const child = await loadToolWithFakePi(agentDir);
			await child.dispatchAsync("agent_start");
			child.dispatch("agent_end", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "STATUS: done\nresumed final report" }],
						stopReason: "stop",
					},
				],
			});
			child.dispatch("agent_settled");
			await vi.waitFor(
				() => {
					expect(parent.sentMessages).toHaveLength(1);
				},
				{ timeout: 3_000, interval: 20 },
			);
			const content = firstMessageContent(parent.sentMessages[0]?.message);
			expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
			expect(content).toContain("resumed final report");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	test("orchestrator shutdown removes the published result socket", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-hsa-pub-"));
		try {
			const agentDir = path.join(root, "agent");
			await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			const loaded = await loadToolWithFakePi(agentDir);
			await loaded.dispatchAsync(
				"session_start",
				{ type: "session_start" },
				{ mode: "print", hasUI: false },
			);
			const publicationPath = path.join(
				agentDir,
				"herdr-subagents",
				"rpc",
				// safeFilePart normalizes the colon in the pane id.
				"owner-wTest-p0.json",
			);
			await vi.waitFor(
				async () => {
					await access(publicationPath);
				},
				{ timeout: 2_000, interval: 10 },
			);

			await loaded.dispatchAsync("session_shutdown");
			await vi.waitFor(
				async () => {
					await expect(access(publicationPath)).rejects.toThrow();
				},
				{ timeout: 2_000, interval: 10 },
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	test("concurrent sends preserve the completion arm for the last follow-up", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-hsa-send-"));
		try {
			const agentDir = path.join(root, "agent");
			await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
			const { log } = await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			setEnv("FAKE_HERDR_AGENT_STATUS", "working");
			const loaded = await loadToolWithFakePi(agentDir);
			loaded.dispatch("session_start", { type: "session_start" }, { mode: "print", hasUI: false });

			const rpcDir = path.join(agentDir, "herdr-subagents", "rpc");
			let socketPath = "";
			await vi.waitFor(
				async () => {
					const socketName = (await readdir(rpcDir)).find(
						(name) => name.startsWith("v1-") && name.endsWith(".sock"),
					);
					expect(socketName).toBeDefined();
					if (socketName) {
						socketPath = path.join(rpcDir, socketName);
					}
				},
				{ timeout: 1_000, interval: 10 },
			);

			await loaded.tool.execute(
				"tool-call-spawn",
				{
					action: "spawn",
					name: "worker-a",
					agentType: "worker",
					task: "Initial task.",
					notify: false,
				},
				undefined,
				undefined,
				makeContext("/workspace"),
			);

			setEnv("FAKE_HERDR_PANE_RUN_DELAY_MESSAGE", "message A");
			setEnv("FAKE_HERDR_PANE_RUN_DELAY_MS", "250");
			const sendA = loaded.tool.execute(
				"tool-call-send-a",
				{ action: "send", target: "worker-a", message: "message A" },
				undefined,
				undefined,
				makeContext("/workspace"),
			);
			await vi.waitFor(
				async () => {
					const calls = readHerdrRequests(log);
					expect(
						calls.some(
							(request) =>
								request.method === "pane.send_input" && request.params.text === "message A",
						),
					).toBe(true);
				},
				{ timeout: 1_000, interval: 10 },
			);
			const sendB = loaded.tool.execute(
				"tool-call-send-b",
				{ action: "send", target: "worker-a", message: "message B" },
				undefined,
				undefined,
				makeContext("/workspace"),
			);
			await Promise.all([sendA, sendB]);

			const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
			expect(armId).toMatch(/^[0-9a-f-]{36}$/u);
			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath,
					name: "worker-a",
					status: "done",
					finalMessage: "the final concurrent-send result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
					armId,
				}),
			);

			await vi.waitFor(
				() => {
					expect(loaded.sentMessages).toHaveLength(1);
				},
				{ timeout: 1_000, interval: 10 },
			);
			expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain(
				"the final concurrent-send result",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 8_000);

	test("a fast completion on an existing watcher is not re-armed after send success", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call-spawn",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Initial task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const originalArmId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
		const launchCommand = firstRunCommand(readHerdrRequests(log));
		const socketPath =
			resultSocketArg(launchCommand)?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";

		setEnv("FAKE_HERDR_PANE_RUN_DELAY_MESSAGE", "fast follow-up");
		setEnv("FAKE_HERDR_PANE_RUN_DELAY_MS", "3000");
		const send = loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "worker-a", message: "fast follow-up" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		let attemptedArmId: string | undefined;
		await vi.waitFor(
			async () => {
				attemptedArmId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
				expect(attemptedArmId).not.toBe(originalArmId);
			},
			{ timeout: 1_000, interval: 10 },
		);
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "fast send result",
				sentAtMs: TEST_FRESH_SENT_AT_MS + 1,
				completionId: "completion-fast",
				armId: attemptedArmId,
			}),
		);
		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 2_500, interval: 25 },
		);
		await send;

		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "unrelated later result",
				sentAtMs: TEST_FRESH_SENT_AT_MS + 2,
				completionId: "completion-later",
				armId: attemptedArmId,
			}),
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 200);
		});
		expect(loaded.sentMessages).toHaveLength(1);
		expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain("fast send result");
	}, 10_000);

	test("an ambiguous failed send preserves its provisional watcher and restores the arm file", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const loaded = await loadToolWithFakePi(agentDir);

		await loaded.tool.execute(
			"tool-call-spawn",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Initial task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const previousArmId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
		expect(previousArmId).toMatch(/^[0-9a-f-]{36}$/u);
		const launchCommand = firstRunCommand(readHerdrRequests(log));
		const socketPath =
			resultSocketArg(launchCommand)?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "the original turn settled",
				sentAtMs: TEST_FRESH_SENT_AT_MS,
				completionId: "completion-original",
				armId: previousArmId,
			}),
		);
		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 3_000, interval: 50 },
		);
		loaded.sentMessages.splice(0);

		setEnv("FAKE_HERDR_PANE_RUN_DELAY_MESSAGE", "message accepted before failure");
		setEnv("FAKE_HERDR_PANE_RUN_DELAY_MS", "250");
		setEnv("FAKE_HERDR_PANE_RUN_FAIL_AFTER_DELAY", "1");
		const failedSend = loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "worker-a", message: "message accepted before failure" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		let attemptedArmId: string | undefined;
		await vi.waitFor(
			async () => {
				attemptedArmId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
				expect(attemptedArmId).toMatch(/^[0-9a-f-]{36}$/u);
				expect(attemptedArmId).not.toBe(previousArmId);
			},
			{ timeout: 1_000, interval: 10 },
		);
		await expect(failedSend).rejects.toThrow(/pane run failed after input/u);
		setEnv("FAKE_HERDR_PANE_RUN_FAIL_AFTER_DELAY", undefined);
		expect(await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"))).toBe(previousArmId);

		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "the attempted send settled",
				sentAtMs: TEST_FRESH_SENT_AT_MS + 1,
				completionId: "completion-attempted",
				armId: attemptedArmId,
			}),
		);
		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 3_000, interval: 50 },
		);
		expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain(
			"the attempted send settled",
		);
	}, 10_000);

	test("RPC server unlinks a stale socket file before listening", async () => {
		const root = await makeTempRoot();
		const socketPath = path.join(root, "stale.sock");
		await writeFile(socketPath, "stale", "utf8");

		const server = await runHerdrSubagentEffect(
			startSubagentRpcServer({
				socketPath,
				onFinished() {},
			}),
		);
		try {
			await runHerdrSubagentEffect(
				notifySubagentFinished({
					socketPath,
					name: "worker-a",
					status: "done",
					finalMessage: "the actual result",
					sentAtMs: TEST_FRESH_SENT_AT_MS,
				}),
			);
		} finally {
			await server.close();
		}
	});

	test("spawns with an explicit model outside the openai-codex family", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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
		const command = lastRunCommand(readHerdrRequests(log));
		expect(command).toContain("--model");
		expect(command).toContain("anthropic/claude-opus-4-8");
	});

	test("resolves role model pins through the registry before spawning", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "anthropic/claude-opus-4.8-20260101");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);
		const registry = makeModelRegistry([
			{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
			{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
		]);

		await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Implement the focused change.",
			},
			undefined,
			undefined,
			makeContext("/workspace", registry),
		);
		const command = lastRunCommand(readHerdrRequests(log));
		expect(command).toContain("--model");
		expect(command).toContain("anthropic/claude-opus-4-8");
	});

	test("rejects an unresolvable spawn model before touching herdr", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "anthropic/missing-model");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);
		const registry = makeModelRegistry([
			{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
			{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
		]);

		await expect(
			tool.execute(
				"tool-call",
				{
					action: "spawn",
					name: "worker-a",
					agentType: "worker",
					task: "Implement the focused change.",
				},
				undefined,
				undefined,
				makeContext("/workspace", registry),
			),
		).rejects.toThrow(
			/Model not found: "anthropic\/missing-model"[\s\S]*anthropic\/claude-opus-4-8/,
		);
		expect(readHerdrRequests(log)).toEqual([]);
	});

	test("agent discovery skips unreadable md-shaped directory entries", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await mkdir(path.join(agentDir, "agents", "not-an-agent.md"));
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "agent-types" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(result.content[0]?.text).toContain("worker");
	});

	test("close removes a stale registry entry when the tab is already gone, unblocking the name", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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

	test("concurrent spawns all persist in the registry", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		// pi executes sibling tool calls in parallel; spawns must not clobber
		// each other's registry writes.
		await Promise.all([
			tool.execute(
				"tool-call-a",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
			tool.execute(
				"tool-call-b",
				{ action: "spawn", name: "worker-b", agentType: "worker", task: "Task B." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		]);

		const status = await tool.execute(
			"tool-call-status",
			{ action: "status" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		const text = status.content[0]?.text ?? "";
		expect(text).toContain("worker-a");
		expect(text).toContain("worker-b");
	});

	test("rejects Terra below high thinking before touching herdr", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-terra");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		for (const [index, thinking] of [undefined, "low", "medium"].entries()) {
			await expect(
				tool.execute(
					`tool-call-${index}`,
					{
						action: "spawn",
						name: `worker-${index}`,
						agentType: "worker",
						thinking,
						task: "Implement the focused change.",
					},
					undefined,
					undefined,
					makeContext("/workspace"),
				),
			).rejects.toThrow(/Terra requires high or xhigh thinking/);
		}

		expect(readHerdrRequests(log)).toEqual([]);
	});

	test("allows Terra with high or xhigh thinking", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-terra", "high");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call-high",
			{ action: "spawn", name: "worker-high", agentType: "worker", task: "High task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		await tool.execute(
			"tool-call-xhigh",
			{
				action: "spawn",
				name: "worker-xhigh",
				agentType: "worker",
				thinking: "xhigh",
				task: "Xhigh task.",
			},
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		const commands = readHerdrRequests(log)
			.filter((request) => request.method === "pane.send_input")
			.map((request) => request.params.text ?? "");
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain("'high'");
		expect(commands[1]).toContain("'xhigh'");
	});

	test("role default thinking is applied and an explicit thinking overrides it", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "planner", "openai-codex/gpt-5.6-sol", "high");
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
		const defaultCommand = lastRunCommand(readHerdrRequests(log));
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
		const overriddenCommand = lastRunCommand(readHerdrRequests(log));
		expect(overriddenCommand).toContain("'medium'");
		expect(overriddenCommand).not.toContain("'high'");
	});

	test("a silent Herdr socket request is reported as a timeout", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_WAIT_HANG", "1");
		const tool = await loadTool(agentDir);

		// Non-done statuses use the SDK's server-side agent wait.
		await expect(
			tool.execute(
				"tool-call",
				{ action: "wait", target: "wTest:p1", status: "working", timeoutMs: 300 },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/timed out/);
	}, 8_000);

	test("wait for done resolves when herdr reports done", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "wait", target: "wTest:p1", timeoutMs: 2_000 },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(result.content[0]?.text).toContain("finished");
	}, 8_000);

	test("wait for done resolves when the finished pane reports idle (already viewed)", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		// Herdr reports `idle`, not `done`, once a finished pane has been viewed.
		setEnv("FAKE_HERDR_AGENT_STATUS", "idle");
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "wait", target: "wTest:p1", timeoutMs: 2_000 },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(result.content[0]?.text).toContain("finished");
		expect(result.content[0]?.text).toContain("idle");
	}, 8_000);

	test("wait for done times out while the subagent is still working", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "wait", target: "wTest:p1", timeoutMs: 500 },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/timed out .* last agent status: working/);
	}, 8_000);

	test("close still fails when the tab exists but herdr close fails", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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
		).rejects.toThrow(/fixture_rejected|unknown tab/);

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

	test("close preserves registry state when the existence check gets a malformed response", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
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
		setEnv("FAKE_HERDR_TAB_CLOSE_FAIL", "1");
		setEnv("FAKE_HERDR_TAB_GET_MALFORMED", "1");

		await expect(
			tool.execute(
				"tool-call-close",
				{ action: "close", target: "worker-a" },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/invalid|response|transport/i);
		await access(path.join(agentDir, "herdr-subagents", "registry", "worker-a.json"));
	});

	test("wait ignores transient startup idle before working", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "idle\nidle\nidle\nworking\ndone\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		const tool = await loadTool(agentDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "wait", target: "wTest:p1", timeoutMs: 5_000 },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(result.details).toEqual(expect.objectContaining({ observed: "done" }));
		expect(result.content[0]?.text).not.toContain("reported idle");
	}, 8_000);

	test("only one same-name concurrent spawn succeeds", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		const results = await Promise.allSettled([
			tool.execute(
				"tool-call-a",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
			tool.execute(
				"tool-call-b",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task B." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.reason).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/already registered/) }),
		);
		const calls = readHerdrRequests(log);
		expect(calls.filter((request) => request.method === "tab.create")).toHaveLength(1);
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		const files = await readdir(registryDir);
		expect(files.filter((name) => name === "worker-a.json")).toHaveLength(1);
		const registryText = await readFile(path.join(registryDir, "worker-a.json"), "utf8");
		expect(registryText).toContain('"name": "worker-a"');
	});

	test("legacy registry entries without an owner pane still decode", async () => {
		const decoded = await runHerdrSubagentEffect(
			decodeRegistryEntry({
				name: "legacy",
				cwd: "/workspace",
				label: "agent: legacy",
				taskFile: "/tmp/task-legacy.md",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		);

		expect(decoded.ownerPaneId).toBeUndefined();
	});

	test("corrupt registry entries are ignored without wiping valid entries", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		await mkdir(registryDir, { recursive: true });
		await writeFile(path.join(registryDir, "bad.json"), "not-json", "utf8");
		await writeFile(
			path.join(registryDir, "kept.json"),
			JSON.stringify(
				{
					name: "kept",
					target: "term-kept",
					paneId: "wTest:p9",
					cwd: "/workspace",
					label: "agent: kept",
					taskFile: "/tmp/task-kept.md",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				null,
				2,
			),
			"utf8",
		);
		const tool = await loadTool(agentDir);

		const status = await tool.execute(
			"tool-call-status",
			{ action: "status" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(status.content[0]?.text).toContain("kept");
		expect(await readFile(path.join(registryDir, "bad.json"), "utf8")).toBe("not-json");
		expect(await readFile(path.join(registryDir, "kept.json"), "utf8")).toContain('"name": "kept"');

		const spawned = await tool.execute(
			"tool-call-spawn",
			{ action: "spawn", name: "other", task: "Unrelated task." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
		expect(spawned.content[0]?.text).toContain("Spawned other");
		expect(await readFile(path.join(registryDir, "bad.json"), "utf8")).toBe("not-json");
	});

	test("migrates a legacy registry.json on status", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const runtimeDir = path.join(agentDir, "herdr-subagents");
		await mkdir(runtimeDir, { recursive: true });
		await writeFile(
			path.join(runtimeDir, "registry.json"),
			JSON.stringify(
				{
					version: 1,
					entries: {
						legacy: {
							name: "legacy",
							target: "term-legacy",
							paneId: "wTest:p9",
							cwd: "/workspace",
							label: "agent: legacy",
							taskFile: "/tmp/task-legacy.md",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		const tool = await loadTool(agentDir);

		const status = await tool.execute(
			"tool-call-status",
			{ action: "status" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(status.content[0]?.text).toContain("legacy");
		expect(await readFile(path.join(runtimeDir, "registry", "legacy.json"), "utf8")).toContain(
			'"name": "legacy"',
		);
		expect(await readFile(path.join(runtimeDir, "registry.json.migrated"), "utf8")).toContain(
			'"legacy"',
		);
	});

	test("reserve treats a corrupt same-name entry as already registered without changing it", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		await mkdir(registryDir, { recursive: true });
		const corruptPath = path.join(registryDir, "worker-a.json");
		const corruptBytes = "{ not valid json";
		await writeFile(corruptPath, corruptBytes, "utf8");
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "spawn", name: "worker-a", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/already registered/);
		expect(await readFile(corruptPath, "utf8")).toBe(corruptBytes);
	});

	test("stale reservations can be taken over by spawn", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		await mkdir(registryDir, { recursive: true });
		const staleAt = "2000-01-01T00:00:00.000Z";
		await writeFile(
			path.join(registryDir, "worker-a.json"),
			JSON.stringify(
				{
					name: "worker-a",
					phase: "reserved",
					cwd: "/workspace",
					label: "agent: worker-a",
					agentType: "worker",
					model: "openai-codex/gpt-5.6-sol",
					taskFile: "",
					createdAt: staleAt,
					updatedAt: staleAt,
				},
				null,
				2,
			),
			"utf8",
		);
		const tool = await loadTool(agentDir);

		const spawned = await tool.execute(
			"tool-call",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
			undefined,
			undefined,
			makeContext("/workspace"),
		);

		expect(spawned.content[0]?.text).toContain("Spawned worker-a");
		expect(await readFile(path.join(registryDir, "worker-a.json"), "utf8")).toContain(
			'"phase": "active"',
		);
	});

	test("only one concurrent spawn takes over a stale reservation", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		await mkdir(registryDir, { recursive: true });
		const staleAt = "2000-01-01T00:00:00.000Z";
		await writeFile(
			path.join(registryDir, "worker-a.json"),
			JSON.stringify(
				{
					name: "worker-a",
					phase: "reserved",
					cwd: "/workspace",
					label: "agent: worker-a",
					agentType: "worker",
					model: "openai-codex/gpt-5.6-sol",
					taskFile: "",
					createdAt: staleAt,
					updatedAt: staleAt,
				},
				null,
				2,
			),
			"utf8",
		);
		const tool = await loadTool(agentDir);

		const results = await Promise.allSettled([
			tool.execute(
				"tool-call-a",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
			tool.execute(
				"tool-call-b",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task B." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.reason).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/already registered/) }),
		);
		const calls = readHerdrRequests(log);
		expect(calls.filter((request) => request.method === "tab.create")).toHaveLength(1);
		expect(await readFile(path.join(registryDir, "worker-a.json"), "utf8")).toContain(
			'"phase": "active"',
		);
	});

	test("fresh reservations block spawn with the same name", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const registryDir = path.join(agentDir, "herdr-subagents", "registry");
		await mkdir(registryDir, { recursive: true });
		const now = "2999-01-01T00:00:00.000Z";
		await writeFile(
			path.join(registryDir, "worker-a.json"),
			JSON.stringify(
				{
					name: "worker-a",
					phase: "reserved",
					cwd: "/workspace",
					label: "agent: worker-a",
					agentType: "worker",
					model: "openai-codex/gpt-5.6-sol",
					taskFile: "",
					createdAt: now,
					updatedAt: now,
				},
				null,
				2,
			),
			"utf8",
		);
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/already registered/);
	});

	test("invalid spawn names fail before running herdr commands", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "spawn", name: "bad/name", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(
			/Invalid subagent name bad\/name: use 1-64 characters of letters, digits, dot, underscore, or hyphen\./,
		);
		expect(readHerdrRequests(log)).toEqual([]);
	});

	test("spawn pane run failure closes the created tab and clears the reservation", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("FAKE_HERDR_PANE_RUN_FAIL", "1");
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
				undefined,
				undefined,
				makeContext("/workspace"),
			),
		).rejects.toThrow(/pane run failed/);

		const calls = readHerdrRequests(log);
		expect(calls).toContainEqual(
			expect.objectContaining({ method: "tab.close", params: { tab_id: "wTest:t2" } }),
		);
		await expect(
			readFile(path.join(agentDir, "herdr-subagents", "registry", "worker-a.json"), "utf8"),
		).rejects.toThrow();
	});
});
