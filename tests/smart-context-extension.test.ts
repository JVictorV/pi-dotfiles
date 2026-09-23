import { readFile } from "node:fs/promises";
import type { ToolResultMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import smartContext from "../agent/extensions/smart-context/index";
import {
	createSmartContextHarness,
	type ScriptedResponse,
	type SmartContextHarness,
	type SmartContextHarnessOptions,
} from "./smart-context-harness";

const harnesses: SmartContextHarness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

async function create(
	options: Omit<SmartContextHarnessOptions, "extension" | "streamFn"> & {
		responses: readonly ScriptedResponse[];
		extension?: ExtensionFactory;
	},
) {
	const harness = await createSmartContextHarness({
		...options,
		extension: options.extension ?? smartContext,
	});
	harnesses.push(harness);
	return harness;
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}
function tools(...content: ToolCall[]): ScriptedResponse {
	return { content };
}
function result(session: AgentSession, id: string) {
	const message = session.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === id,
	);
	if (!message || message.role !== "toolResult") throw new Error(`Missing tool result ${id}`);
	return message;
}
function text(content: ToolResultMessage["content"]): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
function usage(input: number): Usage {
	return {
		input,
		output: 1,
		totalTokens: input + 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// These tests prevent loss of task state and unintended model summarization at the real Pi boundary.
describe("smart context real Pi session", () => {
	test("checkpoint write persists to disk and a reopened session reads it", async () => {
		const first = await create({
			responses: [
				tools(
					call("write", "context_notes", {
						action: "write",
						text: "Keep the exact user constraints.",
					}),
				),
				"saved",
			],
		});
		await first.session.prompt("Remember the constraints.");
		expect(result(first.session, "write").isError).toBe(false);
		const file = first.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		expect(await readFile(file, "utf8")).toContain("Keep the exact user constraints.");
		first.session.dispose();
		const reopened = await create({
			sessionFile: file,
			responses: [tools(call("read", "context_notes", { action: "read" })), "restored"],
		});
		await reopened.session.prompt("Read the checkpoint.");
		const restored = result(reopened.session, "read");
		expect(restored.isError).toBe(false);
		expect(JSON.parse(text(restored.content))).toMatchObject({
			text: "Keep the exact user constraints.",
			windowId: "initial",
		});
	});

	test("voluntary reset finishes its continuation before prompt resolves, without a summarizer", async () => {
		const h = await create({
			// Pi needs enough history before its retained tail to prepare compaction.
			compaction: { enabled: false, keepRecentTokens: 128 },
			responses: [
				tools(
					call("write", "context_notes", {
						action: "write",
						text: `Continue from checkpoint Alpha. ${"Completed verified task step. ".repeat(40)}`,
					}),
				),
				tools(call("reset", "new_context")),
				"continued from checkpoint",
			],
		});
		await h.session.prompt("Original request uniquely marked ORIGINAL-123.");
		expect(h.extensionErrors).toEqual([]);
		// Do not wait for a later event here: print callers own only the prompt lifetime.
		expect(h.capturedContexts).toHaveLength(3);
		expect(h.session.isStreaming).toBe(false);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "continued from checkpoint" }],
		});
		const resumed = JSON.stringify(h.capturedContexts.at(-1)?.messages);
		expect(resumed).toContain("Continue from checkpoint Alpha.");
		expect(resumed).not.toContain("ORIGINAL-123");
		expect(resumed).not.toContain('"toolCallId":"write"');
		expect(resumed).not.toContain('"toolCallId":"reset"');
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
		).toHaveLength(1);
	});

	test("manual full reset retains only a recovery seed, and history reads the exact archived request", async () => {
		const responses: ScriptedResponse[] = ["original assistant payload"];
		const h = await create({ responses, compaction: { enabled: false, keepRecentTokens: 1 } });
		const original = "Exact request: [] .* 😀\nsecond line\tend";
		await h.session.prompt(original);
		const user = h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!user) throw new Error("Missing persisted user entry");
		await h.session.compact();
		expect(h.capturedContexts).toHaveLength(1);
		const active = JSON.stringify(h.session.messages);
		expect(active).toContain("Smart context recovery");
		expect(active).toContain(user.id);
		expect(active).not.toContain("original assistant payload");
		expect(active).not.toContain("Exact request:");
		responses.push(
			tools(call("history", "context_history", { action: "read", id: user.id, limit: 8000 })),
			"recovered",
		);
		await h.session.prompt("Recover the original request.");
		const recovered = result(h.session, "history");
		expect(recovered.isError).toBe(false);
		expect(JSON.parse(text(recovered.content))).toMatchObject({ text: original, nextOffset: null });
		expect(h.capturedContexts).toHaveLength(3);
	});

	test("threshold reset without a checkpoint uses history recovery and never summarizes", async () => {
		const h = await create({
			contextWindow: 20000,
			compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
			responses: [
				{ content: [{ type: "text", text: "old threshold response" }], usage: usage(19000) },
				"next response",
			],
		});
		const reasons: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") reasons.push(event.reason);
		});
		await h.session.prompt("Original threshold request.");
		expect(reasons).toContain("threshold");
		expect(h.capturedContexts).toHaveLength(1);
		expect(JSON.stringify(h.session.messages)).toContain("No saved checkpoint was available");
		expect(JSON.stringify(h.session.messages)).not.toContain("old threshold response");
		await h.session.prompt("Continue after threshold.");
		expect(h.capturedContexts).toHaveLength(2);
	});

	test("overflow retries from local history without a checkpoint or summarizer", async () => {
		const h = await create({
			contextWindow: 20000,
			compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
			responses: [
				"previous complete turn",
				{ content: [], stopReason: "error", errorMessage: "maximum context length exceeded" },
				"recovered after overflow",
			],
		});
		const reasons: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") reasons.push(event.reason);
		});
		await h.session.prompt("Earlier work.");
		await h.session.prompt("Original overflow request.");
		expect(reasons).toEqual(["overflow"]);
		expect(h.capturedContexts).toHaveLength(3);
		expect(JSON.stringify(h.capturedContexts[2]?.messages)).toContain(
			"No saved checkpoint was available",
		);
		expect(JSON.stringify(h.capturedContexts[2]?.messages)).not.toContain(
			"Original overflow request.",
		);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after overflow" }],
		});
	});

	test("mixed new_context batch is rejected without dropping messages", async () => {
		const h = await create({
			responses: [
				tools(call("write", "context_notes", { action: "write", text: "Current task" })),
				tools(call("reset", "new_context"), call("read", "context_notes", { action: "read" })),
				"batch rejected",
			],
		});
		await h.session.prompt("Keep this original request.");
		expect(result(h.session, "reset").isError).toBe(true);
		expect(text(result(h.session, "reset").content)).toContain("Call new_context alone");
		expect(result(h.session, "read").isError).toBe(false);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.session.messages)).toContain("Keep this original request.");
	});

	test("queued user input cancels a pending reset without losing the new request", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = await create({
			extension(pi) {
				smartContext(pi);
				pi.on("tool_call", async (event) => {
					if (event.toolName === "new_context") {
						reached.resolve();
						await release.promise;
					}
				});
			},
			responses: [
				tools(call("write", "context_notes", { action: "write", text: "Old checkpoint" })),
				tools(call("reset", "new_context")),
				"Processed new constraints",
			],
		});
		const prompt = h.session.prompt("Original request");
		try {
			await reached.promise;
			await h.session.steer("New constraint: preserve this queued request.");
		} finally {
			release.resolve();
		}
		await prompt;
		expect(result(h.session, "reset").isError).toBe(true);
		expect(text(result(h.session, "reset").content)).toContain("queued input");
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.capturedContexts.at(-1)?.messages)).toContain(
			"New constraint: preserve this queued request.",
		);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Processed new constraints" }],
		});
	});

	test("Escape during full reset keeps the old context and starts no continuation", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = await create({
			compaction: { enabled: false, keepRecentTokens: 1 },
			extension(pi) {
				smartContext(pi);
				pi.on("session_before_compact", async () => {
					reached.resolve();
					await release.promise;
				});
			},
			responses: ["Original response remains available"],
		});
		await h.session.prompt("Original request remains available");
		const original = structuredClone(h.session.messages);
		const compact = h.session.compact();
		// Observe rejection immediately so interruption cannot cause an unhandled rejection.
		const outcome = compact.then(
			() => "completed",
			() => "aborted",
		);
		try {
			await reached.promise;
			h.session.abortCompaction();
		} finally {
			release.resolve();
		}
		expect(await outcome).toBe("aborted");
		expect(h.session.messages).toEqual(original);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(h.capturedContexts).toHaveLength(1);
	});

	test("pre-hook cancellation cannot start another model request when Pi misclassifies the refusal", async () => {
		const h = await create({
			responses: [
				tools(call("write", "context_notes", { action: "write", text: "Short checkpoint" })),
				tools(call("reset", "new_context")),
				"This continuation must not run",
			],
		});
		const failures: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
		h.session.subscribe((event) => {
			// Native manual compaction emits start before awaiting auth or preparing
			// the cut. An abort here never reaches session_before_compact on refusal.
			if (event.type === "compaction_start") h.session.abortCompaction();
			if (event.type === "compaction_end") failures.push(event);
		});
		await h.session.prompt("Complete this small task.");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			aborted: false,
			errorMessage: expect.stringContaining("Nothing to compact"),
		});
		expect(h.capturedContexts).toHaveLength(2);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(h.session.isIdle).toBe(true);
	});

	test("refused tiny-session reset stops visibly and resumes only on new user input", async () => {
		const h = await create({
			responses: [
				tools(call("write", "context_notes", { action: "write", text: "Short checkpoint" })),
				tools(call("reset", "new_context")),
				"Final answer after reset refusal",
			],
		});
		await h.session.prompt("Complete this small task.");
		expect(h.extensionErrors).toEqual([]);
		expect(h.capturedContexts).toHaveLength(2);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.session.messages)).toContain("Complete this small task.");
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "smart-context-reset-stopped",
			display: true,
			content: expect.stringContaining("Automatic continuation was skipped"),
		});
		await h.session.prompt("Continue without resetting context.");
		expect(h.capturedContexts).toHaveLength(3);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Final answer after reset refusal" }],
		});
	});

	test("Escape during the second voluntary reset settles the original prompt without another continuation", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let resets = 0;
		const h = await create({
			compaction: { enabled: false, keepRecentTokens: 128 },
			extension(pi) {
				smartContext(pi);
				pi.on("session_before_compact", async () => {
					if (++resets === 2) {
						reached.resolve();
						await release.promise;
					}
				});
			},
			responses: [
				tools(
					call("write-1", "context_notes", {
						action: "write",
						text: `Checkpoint one. ${"First stage verified. ".repeat(60)}`,
					}),
				),
				tools(call("reset-1", "new_context")),
				tools(
					call("write-2", "context_notes", {
						action: "write",
						text: `Checkpoint two. ${"Second stage verified. ".repeat(60)}`,
					}),
				),
				tools(call("reset-2", "new_context")),
			],
		});
		const compactions: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") compactions.push(event);
		});
		const prompt = h.session.prompt("Keep working across context windows.");
		try {
			await reached.promise;
			h.session.abortCompaction();
		} finally {
			release.resolve();
		}
		await prompt;
		expect(h.extensionErrors).toEqual([]);
		expect(compactions.map((event) => event.aborted)).toEqual([false, true]);
		expect(h.capturedContexts).toHaveLength(4);
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
		).toHaveLength(1);
		expect(JSON.stringify(h.session.messages)).toContain("Checkpoint two.");
		expect(h.session.isIdle).toBe(true);
	});

	test("a refused second reset settles the original prompt and requires new user input", async () => {
		const h = await create({
			compaction: { enabled: false, keepRecentTokens: 128 },
			responses: [
				tools(
					call("write-1", "context_notes", {
						action: "write",
						text: `Checkpoint one. ${"First stage verified. ".repeat(60)}`,
					}),
				),
				tools(call("reset-1", "new_context")),
				tools(
					call("write-2", "context_notes", { action: "write", text: "Short second checkpoint" }),
				),
				tools(call("reset-2", "new_context")),
				"Finished despite second reset refusal",
			],
		});
		const compactions: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") compactions.push(event);
		});
		await h.session.prompt("Finish after another short step.");
		expect(h.extensionErrors).toEqual([]);
		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.result).toBeDefined();
		expect(compactions[1]).toMatchObject({
			aborted: false,
			errorMessage: expect.stringContaining("Nothing to compact"),
		});
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
		).toHaveLength(1);
		expect(h.capturedContexts).toHaveLength(4);
		expect(JSON.stringify(h.session.messages)).toContain("Short second checkpoint");
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "smart-context-reset-stopped",
			display: true,
			content: expect.stringContaining("Automatic continuation was skipped"),
		});
		expect(h.session.isIdle).toBe(true);
		await h.session.prompt("Continue without another reset.");
		expect(h.capturedContexts).toHaveLength(5);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Finished despite second reset refusal" }],
		});
		expect(h.session.isIdle).toBe(true);
	});

	test("the next request receives checkpoint guidance at 80% usage before threshold compaction", async () => {
		const h = await create({
			contextWindow: 20000,
			compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 128 },
			responses: [
				{ content: [{ type: "text", text: "Progress at 80 percent usage" }], usage: usage(16000) },
				"Continued with checkpoint guidance",
			],
		});
		const compactions: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_start") compactions.push(event.reason);
		});
		await h.session.prompt("Do the first part.");
		await h.session.prompt("Do the next part.");
		expect(h.capturedContexts).toHaveLength(2);
		const messages = JSON.stringify(h.capturedContexts[1]?.messages);
		expect(messages).toContain(
			"Save an updated checkpoint with context_notes, then call new_context alone",
		);
		expect(compactions).toEqual([]);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	test("two consecutive resets finish both continuations within the original prompt", async () => {
		const h = await create({
			compaction: { enabled: false, keepRecentTokens: 128 },
			responses: [
				tools(
					call("write-1", "context_notes", {
						action: "write",
						text: `Checkpoint one. ${"First stage verified. ".repeat(60)}`,
					}),
				),
				tools(call("reset-1", "new_context")),
				tools(
					call("write-2", "context_notes", {
						action: "write",
						text: `Checkpoint two. ${"Second stage verified. ".repeat(60)}`,
					}),
				),
				tools(call("reset-2", "new_context")),
				"Finished both resets",
			],
		});
		await h.session.prompt("Complete a task across two windows.");
		expect(h.extensionErrors).toEqual([]);
		expect(h.capturedContexts).toHaveLength(5);
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
		).toHaveLength(2);
		expect(h.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Finished both resets" }],
		});
		const final = JSON.stringify(h.capturedContexts.at(-1)?.messages);
		expect(final).toContain("Checkpoint two");
		expect(final).not.toContain("Checkpoint one");
	});
});
