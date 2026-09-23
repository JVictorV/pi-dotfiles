import { Schema } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createSubagentNotificationManager } from "./notifications";
import {
	cleanupHarness,
	installFakeHerdr,
	loadToolWithFakePi,
	makeContext,
	makeTempRoot,
	runHerdrSubagentEffect,
	setEnv,
	writeAgent,
} from "./test-harness";
import {
	notifySubagentFinished,
	readPublishedResultSocket,
	readSubagentCompletionArm,
} from "./subagent-rpc";

afterEach(cleanupHarness);

const neverResolvingRunPromise = <A>(): Promise<A> => new Promise(() => {});

const decodeMessage = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.Unknown }));
const decodeNotification = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }));
const contentOf = (message: unknown): string => decodeNotification(message).content;

// Previously queued envelopes have no completion receipt and required an extra
// inspection even when their final report was already read from the pane.
const legacyContent = (content: string): string => {
	const directives = [
		...content.matchAll(/<subagent_result name="([^"]*)" state="[^"]*" pane="([^"]*)">/gu),
	].map(
		(match) =>
			`<required_action tool="herdr_subagent" action="inspect" target="${match[1]}" pane="${match[2]}">Inspect the report.</required_action>`,
	);
	return (
		content
			.replace(/<completion_id>[\s\S]*?<\/completion_id>/gu, "")
			.replace(/<result_guidance>[\s\S]*?<\/result_guidance>/gu, "") +
		"\n" +
		directives.join("\n")
	);
};

const closedMessage = (name: string, paneId: string, isError = false) => ({
	role: "toolResult" as const,
	toolName: "herdr_subagent",
	toolCallId: "close-panel",
	isError,
	content: [],
	timestamp: 0,
	details: { action: "close", resolved: { name, paneId } },
});

const queuedMessage = (content: string) => ({
	role: "custom" as const,
	customType: "herdr-subagent-result",
	content,
	display: true,
	timestamp: 0,
});

describe("delayed subagent notification context", () => {
	test("a completion arriving during inspection announces its identity without repeating the visible report", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Current task" });
			const acknowledge = manager.beginInspection();
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "The exact completed report",
				sentAtMs: 4_000_000_000_000,
				completionId: "during-inspection",
			});
			const consumedCompletions = acknowledge("worker-a", "wTest:p1", "The exact completed report");
			expect(consumedCompletions).toEqual([]);
			const inspected = {
				role: "toolResult",
				toolName: "herdr_subagent",
				toolCallId: "inspect",
				isError: false,
				content: [{ type: "text", text: "The exact completed report" }],
				details: {
					action: "inspect",
					resolved: { name: "worker-a", paneId: "wTest:p1" },
					consumedCompletions,
				},
			};
			const notification = queuedMessage(contentOf(loaded.sentMessages[0]?.message));
			const messages = await loaded.transformContext([inspected, notification]);
			expect(messages).toHaveLength(2);
			expect(contentOf(messages[1])).toContain("<completion_id>during-inspection</completion_id>");
			expect(contentOf(messages[1])).not.toContain("The exact completed report");
			expect(contentOf(messages[1])).toContain("<report_already_visible>");
			expect(await loaded.transformContext(messages)).toEqual(messages);
		} finally {
			manager.cancelAll();
		}
	});

	test.each(["partial", "failed", "new-task", "changed-operator", "different-pane"])(
		"preserves an unread legacy report after %s inspection",
		async (scenario) => {
			const root = await makeTempRoot();
			const loaded = await loadToolWithFakePi(root);
			const content =
				'<subagent_result name="worker-a" state="done" pane="wTest:p1"><final_message>Report: x + y</final_message></subagent_result>';
			const notification = queuedMessage(content);
			const resolved = {
				name: "worker-a",
				paneId: scenario === "different-pane" ? "wOther:p1" : "wTest:p1",
			};
			const inspected = {
				role: "toolResult",
				toolName: "herdr_subagent",
				toolCallId: "inspect",
				isError: scenario === "failed",
				content: [
					{
						type: "text",
						text:
							scenario === "partial"
								? "Report: x"
								: scenario === "changed-operator"
									? "Report: x - y"
									: "Report: x + y",
					},
				],
				details: { action: "inspect", resolved },
			};
			const sent = {
				role: "toolResult",
				toolName: "herdr_subagent",
				toolCallId: "send",
				isError: false,
				content: [],
				details: { action: "send", resolved },
			};
			const messages = await loaded.transformContext([
				inspected,
				...(scenario === "new-task" ? [sent] : []),
				notification,
			]);
			expect(messages.at(-1)).toEqual(notification);
		},
	);

	test("removes only consumed members from an already queued group", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A" });
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "Result A",
				sentAtMs: 4_000_000_000_000,
				completionId: "queued-a",
			});
			manager.deliverExternal("worker-b", {
				status: "done",
				finalMessage: "Result B",
				sentAtMs: 4_000_000_000_000,
				completionId: "queued-b",
			});
			const consumedCompletions = manager.beginInspection()("worker-a", "wTest:p1", "Result A");
			const inspection = {
				role: "toolResult",
				toolName: "herdr_subagent",
				toolCallId: "inspect",
				isError: false,
				content: [{ type: "text", text: "Result A" }],
				details: {
					action: "inspect",
					resolved: { name: "worker-a", paneId: "wTest:p1" },
					consumedCompletions,
				},
			};
			const original = queuedMessage(contentOf(loaded.sentMessages[0]?.message));
			const messages = await loaded.transformContext([inspection, original]);
			expect(messages).toHaveLength(2);
			expect(contentOf(messages[1])).toContain('delivered="1"');
			expect(contentOf(messages[1])).toContain("Result B");
			expect(contentOf(messages[1])).not.toContain("Result A");
			expect(await loaded.transformContext(messages)).toEqual(messages);
			expect(original.content).toContain("Result A");
		} finally {
			manager.cancelAll();
		}
	});

	test("truncated RPC reports still require inspection and cannot be marked fully read", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Long report" });
			const report = "Report line\n".repeat(2500);
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: report,
				sentAtMs: 4_000_000_000_000,
				completionId: "truncated",
			});
			const content = contentOf(loaded.sentMessages[0]?.message);
			expect(content).toContain("Output truncated");
			expect(content).toContain('<required_action tool="herdr_subagent" action="inspect"');
			expect(manager.beginInspection()("worker-a", "wTest:p1", content)).toEqual([]);
		} finally {
			manager.cancelAll();
		}
	});

	test("presentation normalization consumes a complete Markdown report without changing user quotations", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Formatted report" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "## Result\n**Verified** `x + y`.\n- One check passed.",
				sentAtMs: 4_000_000_000_000,
				completionId: "formatted",
			});
			expect(
				manager.beginInspection()(
					"worker-a",
					"wTest:p1",
					"Result\nVerified x + y.\n• One check passed.",
				),
			).toEqual(["formatted"]);
			const notification = queuedMessage(contentOf(loaded.sentMessages[0]?.message));
			const user = { role: "user", content: notification.content, timestamp: 1 };
			expect(await loaded.transformContext([user, notification, notification])).toEqual([
				user,
				notification,
			]);
		} finally {
			manager.cancelAll();
		}
	});

	test("real RPC completion is consumed by inspection and stays consumed after context reset", async () => {
		// The generated RPC socket name must fit Linux's Unix-socket path limit.
		const root = await makeTempRoot("pi-hsa-");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		setEnv("HERDR_PANE_ID", "wTest:p0");
		setEnv("FAKE_HERDR_AGENT_STATUS", "done");
		await writeAgent(root, "worker", "openai-codex/gpt-6-astra");
		const loaded = await loadToolWithFakePi(root);
		await loaded.dispatchAsync("session_start", {}, { mode: "print", hasUI: false });
		const socketPath = await vi.waitFor(async () => {
			const socket = await runHerdrSubagentEffect(readPublishedResultSocket("wTest:p0"));
			expect(socket).toBeDefined();
			return socket;
		});
		if (!socketPath) throw new Error("Result server did not start");
		const ctx = makeContext(root);
		await loaded.tool.execute(
			"spawn",
			{ action: "spawn", name: "worker-a", agentType: "worker", task: "Check the result" },
			undefined,
			undefined,
			ctx,
		);
		const armId = await runHerdrSubagentEffect(readSubagentCompletionArm("worker-a"));
		await runHerdrSubagentEffect(
			notifySubagentFinished({
				socketPath,
				name: "worker-a",
				status: "done",
				finalMessage: "All good.",
				completionId: "rpc-completion-1",
				armId,
				sentAtMs: 4_000_000_000_000,
			}),
		);
		expect(loaded.sentMessages).toHaveLength(1);
		expect(loaded.sentMessages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		const notification = queuedMessage(contentOf(loaded.sentMessages[0]?.message));
		expect(notification.content).not.toContain("<required_action");
		const inspected = await loaded.tool.execute(
			"inspect",
			{ action: "inspect", target: "worker-a" },
			undefined,
			undefined,
			ctx,
		);
		expect(inspected.details).toMatchObject({ consumedCompletions: ["rpc-completion-1"] });
		const archive = SessionManager.inMemory();
		archive.appendMessage({
			role: "toolResult",
			toolName: "herdr_subagent",
			toolCallId: "inspect",
			isError: false,
			content: [...inspected.content],
			details: inspected.details,
			timestamp: 1,
		});
		await loaded.tool.execute(
			"close",
			{ action: "close", target: "worker-a" },
			undefined,
			undefined,
			ctx,
		);
		// No inspection remains in active model context. The receipt is still on
		// the branch, including after a runtime reload with an empty manager cache.
		const reloaded = await loadToolWithFakePi(root);
		expect(await reloaded.transformContext([notification], archive.getBranch())).toEqual([]);
	});

	test("an inspection cannot consume a later completion with identical output", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "First task" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "Same output",
				sentAtMs: 4_000_000_000_000,
				completionId: "first",
			});
			const acknowledge = manager.beginInspection();
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Next task" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "Same output",
				sentAtMs: 4_000_000_000_001,
				completionId: "second",
			});
			const consumedCompletions = acknowledge("worker-a", "wTest:p1", "Same output");
			expect(consumedCompletions).toEqual(["first"]);
			// A new inspection belongs to the latest completion, not every older
			// task whose generic final answer happens to have identical text.
			expect(manager.beginInspection()("worker-a", "wTest:p1", "Same output")).toEqual(["second"]);
			const messages = await loaded.transformContext([
				{
					role: "toolResult",
					toolName: "herdr_subagent",
					toolCallId: "inspect",
					isError: false,
					content: [{ type: "text", text: "Same output" }],
					details: {
						action: "inspect",
						resolved: { name: "worker-a", paneId: "wTest:p1" },
						consumedCompletions,
					},
				},
				...loaded.sentMessages.map((entry) => queuedMessage(contentOf(entry.message))),
			]);
			expect(messages).toHaveLength(2);
			expect(contentOf(messages[1])).toContain("<completion_id>second</completion_id>");
		} finally {
			manager.cancelAll();
		}
	});

	test("partial inspections keep unread reports, while full inspection consumes a report still waiting in a group", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A" });
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "First section.\nSecond section.",
				sentAtMs: 4_000_000_000_000,
				completionId: "group-a",
			});
			const acknowledge = manager.beginInspection();
			expect(acknowledge("worker-a", "wTest:p1", "First section.")).toEqual([]);
			expect(acknowledge("worker-a", "wOther:p1", "First section. Second section.")).toEqual([]);
			expect(acknowledge("worker-a", "wTest:p1", "First section. Second section.")).toEqual([
				"group-a",
			]);
			expect(loaded.sentMessages).toHaveLength(0);
			manager.deliverExternal("worker-b", {
				status: "done",
				finalMessage: "Unseen result B",
				sentAtMs: 4_000_000_000_000,
				completionId: "group-b",
			});
			expect(loaded.sentMessages).toHaveLength(1);
			expect(contentOf(loaded.sentMessages[0]?.message)).toContain("Unseen result B");
			expect(contentOf(loaded.sentMessages[0]?.message)).not.toContain("First section.");
		} finally {
			manager.cancelAll();
		}
	});

	test.each(["inspection", "inspection and closure"])(
		"does not repeat a final report after %s",
		async (sequence) => {
			const root = await makeTempRoot();
			await installFakeHerdr(root);
			setEnv("HERDR_ENV", "1");
			setEnv("FAKE_HERDR_AGENT_STATUS", "done");
			await writeAgent(root, "worker", "openai-codex/gpt-6-astra");
			const loaded = await loadToolWithFakePi(root);
			const ctx = makeContext(root);
			await loaded.tool.execute(
				"spawn",
				{
					action: "spawn",
					name: "worker-a",
					agentType: "worker",
					task: "Check the result",
					notify: false,
				},
				undefined,
				undefined,
				ctx,
			);
			const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
			try {
				manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Check the result" });
				manager.deliverExternal("worker-a", {
					status: "done",
					finalMessage: "All good.",
					sentAtMs: 4_000_000_000_000,
				});
				const notification = queuedMessage(
					legacyContent(contentOf(loaded.sentMessages[0]?.message)),
				);
				const inspected = await loaded.tool.execute(
					"inspect",
					{ action: "inspect", target: "worker-a" },
					undefined,
					undefined,
					ctx,
				);
				const closed =
					sequence === "inspection and closure"
						? await loaded.tool.execute(
								"close",
								{ action: "close", target: "worker-a" },
								undefined,
								undefined,
								ctx,
							)
						: undefined;
				expect(inspected.content[0]?.text).toContain("All good.");
				const messages = await loaded.transformContext([
					{
						role: "toolResult",
						toolName: "herdr_subagent",
						toolCallId: "inspect",
						isError: false,
						timestamp: 1,
						...inspected,
					},
					...(closed
						? [
								{
									role: "toolResult",
									toolName: "herdr_subagent",
									toolCallId: "close",
									isError: false,
									timestamp: 2,
									...closed,
								},
							]
						: []),
					notification,
				]);
				const reportCopies =
					messages
						.map((message) => {
							const { content } = decodeMessage(message);
							return typeof content === "string" ? content : JSON.stringify(content);
						})
						.join("\n")
						.split("All good.").length - 1;
				expect(reportCopies).toBe(1);
			} finally {
				manager.cancelAll();
			}
		},
	);

	test("keeps a closed panel's report without requiring another inspection after reload", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Check the SDK" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "SDK check passed",
				sentAtMs: 4_000_000_000_000,
			});
			const original = queuedMessage(legacyContent(contentOf(loaded.sentMessages[0]?.message)));
			const reloaded = await loadToolWithFakePi(root);
			const messages = await reloaded.transformContext([
				closedMessage("worker-a", "wTest:p1"),
				original,
			]);
			const content = contentOf(messages[1]);
			expect(content).toContain("SDK check passed");
			expect(content).toContain('<subagent_panel_closed name="worker-a" pane="wTest:p1">');
			expect(content).not.toContain("<required_action");
			expect(original.content).toContain("<required_action");
			expect(await reloaded.transformContext(messages)).toEqual(messages);
		} finally {
			manager.cancelAll();
		}
	});

	test("removes only the closed member's inspection from a grouped report", async () => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Task A" });
			manager.arm({ name: "worker-b", paneId: "wTest:p2", summarySource: "Task B" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "Result A",
				sentAtMs: 4_000_000_000_000,
			});
			manager.deliverExternal("worker-b", {
				status: "blocked",
				finalMessage: "Blocker B",
				sentAtMs: 4_000_000_000_000,
			});
			const original = queuedMessage(legacyContent(contentOf(loaded.sentMessages[0]?.message)));
			// The close can follow a report already in history. Old instructions must
			// not demand another lookup on the next model call.
			const closed = {
				...closedMessage("worker-a", "wTest:p1"),
				details: {
					action: "close",
					entry: {
						name: "worker-a",
						paneId: "wTest:p1",
						cwd: root,
						label: "agent: worker-a",
						taskFile: `${root}/task`,
						createdAt: "2026-09-04T00:00:00Z",
						updatedAt: "2026-09-04T00:00:00Z",
					},
				},
			};
			const messages = await loaded.transformContext([original, closed]);
			const content = contentOf(messages[0]);
			expect(content).toContain("Result A");
			expect(content).toContain("Blocker B");
			expect(content).not.toContain('action="inspect" target="worker-a"');
			expect(content).toContain('action="inspect" target="worker-b"');
		} finally {
			manager.cancelAll();
		}
	});

	test.each([
		{ label: "failed close", close: closedMessage("worker-a", "wTest:p1", true) },
		{ label: "reused name in another pane", close: closedMessage("worker-a", "wOld:p1") },
		{ label: "another agent in the same pane", close: closedMessage("worker-b", "wTest:p1") },
	])("preserves inspection for $label", async ({ close }) => {
		const root = await makeTempRoot();
		const loaded = await loadToolWithFakePi(root);
		const manager = createSubagentNotificationManager(loaded.pi, neverResolvingRunPromise);
		try {
			manager.arm({ name: "worker-a", paneId: "wTest:p1", summarySource: "Inspect me" });
			manager.deliverExternal("worker-a", {
				status: "done",
				finalMessage: "Current result",
				sentAtMs: 4_000_000_000_000,
			});
			const original = queuedMessage(legacyContent(contentOf(loaded.sentMessages[0]?.message)));
			const messages = await loaded.transformContext([close, original]);
			expect(messages[1]).toEqual(original);
		} finally {
			manager.cancelAll();
		}
	});
});
