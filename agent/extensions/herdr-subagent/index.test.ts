import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
	cleanupHarness,
	installFakeHerdr,
	lastRunCommandFromCalls,
	loadTool,
	loadToolWithFakePi,
	makeContext,
	makeTempRoot,
	readHerdrCalls,
	runCommandFromCalls,
	runHerdrSubagentEffect,
	setEnv,
	setSubagentSession,
	writeAgent,
} from "./test-harness";
import type { ModelRegistryForResolution, ResolvableModelEntry } from "./model-resolver";
import { createSubagentNotificationManager } from "./notifications";
import { decodeRegistryEntry } from "./schemas";
import { notifySubagentFinished, startSubagentRpcServer } from "./subagent-rpc";

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

const tabCreateCalls = (
	calls: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> =>
	calls.filter((args) => args[0] === "tab" && args[1] === "create");

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

const resultSocketArg = (args: ReadonlyArray<string> | undefined): string | undefined =>
	args?.find((arg) => arg.startsWith("HERDR_SUBAGENT_RESULT_SOCK="));

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
		expect(await readHerdrCalls(log)).toEqual([]);
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
		const status = await tool.execute(
			"tool-call-status",
			{ action: "status" },
			undefined,
			undefined,
			makeContext("/workspace"),
		);
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

	test("spawn records the current pane as the registry owner", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

		const creates = tabCreateCalls(await readHerdrCalls(log));
		expect(creates).toHaveLength(2);
		expect(creates[0]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN=0");
		expect(creates[1]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN=1");
	});

	test("agent frontmatter allowSpawn grants child recursion unless a param overrides it", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		const agentsDir = path.join(agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(
			path.join(agentsDir, "delegator.md"),
			"---\nname: delegator\ndescription: can delegate\nmodel: openai-codex/gpt-5.5\nallowSpawn: true\n---\n\nYou may delegate.\n",
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

		const creates = tabCreateCalls(await readHerdrCalls(log));
		expect(creates).toHaveLength(2);
		expect(creates[0]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN=1");
		expect(creates[1]).toContain("HERDR_SUBAGENT_ALLOW_SPAWN=0");
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

	test("spawn arms a watcher that sends a follow-up result envelope with pane tail", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		// Realistic pickup: the watcher must observe a working phase before trusting done.
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\ndone\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
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

		await vi.waitFor(
			() => {
				expect(loaded.sentMessages).toHaveLength(1);
			},
			{ timeout: 6_000, interval: 50 },
		);
		const delivered = loaded.sentMessages[0];
		const content = firstMessageContent(delivered?.message);
		expect(firstMessageOptions(delivered?.options)).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		expect(content).toContain('<subagent_result name="worker-a" state="done" pane="wTest:p1">');
		expect(content).toContain("Subagent worker-a finished");
		expect(content).toContain("Implement the focused change");
		expect(content).toContain("STATUS: done");
		expect(content).toContain("All good.");
	});

	test("blocked watcher notifications distinguish attention-needed state", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

	test("send replaces a live watcher and delivers exactly one notification", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		// Realistic post-send pickup: the re-armed watcher sees the new turn working, then done.
		// Padded with a second working entry because the about-to-be-replaced spawn watcher may
		// legitimately consume one sequence entry before the send re-arms.
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "working\nworking\ndone\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await loaded.tool.execute(
			"tool-call-send",
			{ action: "send", target: "worker-a", message: "Follow-up after spawn." },
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
		expect(firstMessageContent(loaded.sentMessages[0]?.message)).toContain(
			"Follow-up after spawn.",
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 2_200);
		});
		expect(loaded.sentMessages).toHaveLength(1);
	}, 12_000);

	test("send re-arm distrusts the previous turn's leftover done status", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

	test("session shutdown cancels pending watchers", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
				deliverAs: "followUp",
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
			(effect) => runHerdrSubagentEffect(effect),
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
			(effect) => runHerdrSubagentEffect(effect),
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

	test("RPC result delivery without an armed watcher is dropped", async () => {
		const root = await makeTempRoot();
		const socketPath = path.join(root, "result.sock");
		const sentMessages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
		const manager = createSubagentNotificationManager(
			{
				sendMessage(message, options) {
					sentMessages.push({ message, options });
				},
			},
			(effect) => runHerdrSubagentEffect(effect),
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
			await server.close();
		}
	});

	test("RPC client degrades quickly when the orchestrator socket is unavailable", async () => {
		const root = await makeTempRoot();
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

	test("spawn passes the RPC result socket only after the server is available", async () => {
		const root = await mkdtemp(path.join("/tmp", "pi-hsa-"));
		try {
			const agentDir = path.join(root, "agent");
			await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
			const { log } = await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			setEnv("FAKE_HERDR_AGENT_STATUS", "working");
			const loaded = await loadToolWithFakePi(agentDir);

			await loaded.tool.execute(
				"tool-call-no-rpc",
				{ action: "spawn", name: "worker-a", agentType: "worker", task: "Task A." },
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

			const creates = tabCreateCalls(await readHerdrCalls(log));
			expect(creates).toHaveLength(2);
			expect(resultSocketArg(creates[0])).toBeUndefined();
			const socketArg = resultSocketArg(creates[1]);
			expect(socketArg).toBeDefined();
			const socketPath = socketArg?.replace("HERDR_SUBAGENT_RESULT_SOCK=", "") ?? "";
			await access(socketPath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 8_000);

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

	test("resolves stale dated and dotted role model pins before spawning", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "anthropic/claude-opus-4.8-20260101");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const tool = await loadTool(agentDir);
		const registry = makeModelRegistry([
			{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
			{ provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5 Codex" },
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

		const command = runCommandFromCalls(await readHerdrCalls(log));
		expect(command).toContain("anthropic/claude-opus-4-8");
		expect(command).not.toContain("20260101");
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
			{ provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5 Codex" },
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
		expect(await readHerdrCalls(log)).toEqual([]);
	});

	test("agent discovery skips unreadable md-shaped directory entries", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

	test("concurrent spawns all persist in the registry", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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

		// Non-done statuses still go through the native `herdr wait agent-status`.
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		const calls = await readHerdrCalls(log);
		expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
					model: "openai-codex/gpt-5.5",
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
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
					model: "openai-codex/gpt-5.5",
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
		const calls = await readHerdrCalls(log);
		expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
		expect(await readFile(path.join(registryDir, "worker-a.json"), "utf8")).toContain(
			'"phase": "active"',
		);
	});

	test("fresh reservations block spawn with the same name", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
					model: "openai-codex/gpt-5.5",
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
		expect(await readHerdrCalls(log)).toEqual([]);
	});

	test("spawn pane run failure closes the created tab and clears the reservation", async () => {
		const root = await makeTempRoot();
		const agentDir = path.join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.5");
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
		).rejects.toThrow(/herdr exited with code 1/);

		const calls = await readHerdrCalls(log);
		expect(calls).toContainEqual(["tab", "close", "wTest:t2"]);
		await expect(
			readFile(path.join(agentDir, "herdr-subagents", "registry", "worker-a.json"), "utf8"),
		).rejects.toThrow();
	});
});
