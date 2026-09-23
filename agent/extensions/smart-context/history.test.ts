import { SessionManager } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
	CHECKPOINT_ENTRY,
	currentWindow,
	readCheckpoint,
	recoverySeed,
	requireCheckpoint,
} from "./checkpoint";
import { queryHistory } from "./history";

const ask = (sm: SessionManager, content: string) =>
	sm.appendMessage({ role: "user", content, timestamp: 1 });
const save = (sm: SessionManager, text: string) =>
	sm.appendCustomEntry(CHECKPOINT_ENTRY, {
		version: 1,
		windowId: currentWindow(sm.getBranch()),
		anchorId: sm.getLeafId(),
		text,
	});
const query = (sm: SessionManager, input: unknown) => queryHistory(sm.getBranch(), input);
const read = Effect.fn(function* (sm: SessionManager, id: string, offset = 0, limit = 4000) {
	const result = yield* query(sm, { action: "read", id, offset, limit });
	if (result.kind !== "read") throw new Error("Expected a history read");
	return result;
});
const list = Effect.fn(function* (sm: SessionManager, input: unknown) {
	const result = yield* query(sm, input);
	if (result.kind !== "page") throw new Error("Expected a history page");
	return result;
});

describe("smart context branch archive", () => {
	it.effect(
		"retrieves exact old requirements after compaction and pages literal search results",
		() =>
			Effect.gen(function* () {
				const sm = SessionManager.inMemory();
				const first = ask(sm, "Keep exact A.*B requirements and punctuation.");
				ask(sm, "Another A.*B requirement.");
				const marker = sm.appendCustomEntry("reset", {});
				sm.appendCompaction("Recover using history", marker, 50000);
				ask(sm, "Current request");

				expect(sm.buildSessionContext().messages).not.toContainEqual(
					expect.objectContaining({ content: "Keep exact A.*B requirements and punctuation." }),
				);
				const found = yield* list(sm, { action: "search", query: "A.*B", limit: 1 });
				expect(found.total).toBe(2);
				expect(found.nextOffset).toBe(1);
				// New tool traffic or user input must not move a paginated snapshot.
				ask(sm, "A.*B added after the first page");
				ask(sm, "Another new A.*B item");
				const next = yield* list(sm, {
					action: "search",
					query: "A.*B",
					limit: 1,
					offset: found.nextOffset,
					snapshotId: found.snapshotId,
				});
				expect(next.items[0]?.id).toBe(first);
				expect(next.nextOffset).toBeNull();
				expect(
					(yield* query(sm, { action: "list", offset: 1 }).pipe(Effect.flip)).reason,
				).toContain("snapshotId");
				const start = yield* read(sm, first, 0, 10);
				const rest = yield* read(sm, first, start.nextOffset ?? 0);
				expect(start.text + rest.text).toBe("Keep exact A.*B requirements and punctuation.");
				expect(rest.nextOffset).toBeNull();
				expect((yield* list(sm, { action: "list", windowId: "initial" })).items).toHaveLength(2);
			}),
	);

	it.effect("does not expose sibling branches or extension state", () =>
		Effect.gen(function* () {
			const sm = SessionManager.inMemory();
			const root = ask(sm, "Root");
			const abandoned = ask(sm, "Abandoned branch");
			sm.appendCustomEntry("unrelated-private-data", { value: "private-value" });
			sm.branch(root);
			ask(sm, "Active branch");
			const result = yield* list(sm, { action: "list" });
			expect(result.items.map((item) => item.preview)).toEqual(["Active branch", "Root"]);
			const error = yield* query(sm, { action: "read", id: abandoned }).pipe(Effect.flip);
			expect(error.reason).toContain("not found on the active branch");
		}),
	);

	it.effect("bounds history responses and excludes thinking and provider metadata", () =>
		Effect.gen(function* () {
			const sm = SessionManager.inMemory();
			const long = ask(sm, "😀".repeat(20000));
			sm.appendMessage({
				role: "assistant",
				provider: "test",
				api: "openai-responses",
				model: "test",
				timestamp: 2,
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "hidden-reasoning", thinkingSignature: "opaque-signature" },
					{ type: "text", text: "Visible answer" },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const result = yield* list(sm, { action: "list" });
			expect(JSON.stringify(result)).not.toMatch(/hidden-reasoning|opaque-signature/);
			expect(result.items[0]?.preview).toBe("Visible answer");
			const chunk = yield* read(sm, long, 0, 8000);
			expect(chunk.text.length).toBe(8000);
			expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(50000);
			expect(
				(yield* query(sm, { action: "search", query: "" }).pipe(Effect.flip)).message,
			).toContain("Invalid history request");
			expect(
				(yield* query(sm, { action: "list", limit: 8000 }).pipe(Effect.flip)).message,
			).toContain("Invalid history request");
		}),
	);
});

describe("history execution outcomes", () => {
	it.effect(
		"distinguishes failed tools and cancelled shells from successful identical output",
		() =>
			Effect.gen(function* () {
				const sm = SessionManager.inMemory();
				ask(sm, "Inspect the execution results");
				const succeeded = sm.appendMessage({
					role: "toolResult",
					toolName: "bash",
					toolCallId: "success-call",
					isError: false,
					content: [{ type: "text", text: "same output" }],
					timestamp: 2,
				});
				const failed = sm.appendMessage({
					role: "toolResult",
					toolName: "bash",
					toolCallId: "failed-call",
					isError: true,
					content: [{ type: "text", text: "same output" }],
					timestamp: 3,
				});
				const shell = sm.appendMessage({
					role: "bashExecution",
					command: "test command",
					output: "same output",
					exitCode: 7,
					cancelled: false,
					truncated: true,
					timestamp: 4,
				});
				const cancelled = sm.appendMessage({
					role: "bashExecution",
					command: "cancelled command",
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
					timestamp: 5,
				});
				expect(yield* read(sm, succeeded)).toMatchObject({
					toolName: "bash",
					toolCallId: "success-call",
					isError: false,
				});
				expect(yield* read(sm, failed)).toMatchObject({
					toolName: "bash",
					toolCallId: "failed-call",
					isError: true,
				});
				expect(yield* read(sm, shell)).toMatchObject({
					exitCode: 7,
					cancelled: false,
					truncated: true,
				});
				expect(yield* read(sm, cancelled)).toMatchObject({ exitCode: null, cancelled: true });
				expect(
					(yield* list(sm, { action: "list" })).items.find((item) => item.id === failed),
				).toMatchObject({ isError: true });
			}),
	);
});

describe("smart context checkpoints", () => {
	it.effect("restores the selected branch checkpoint and rejects a stale request/window", () =>
		Effect.gen(function* () {
			const sm = SessionManager.inMemory();
			ask(sm, "First request");
			const firstCheckpoint = save(sm, "First notes");
			ask(sm, "Second request");
			expect((yield* requireCheckpoint(sm.getBranch()).pipe(Effect.flip)).message).toContain(
				"New input arrived",
			);
			save(sm, "Second notes");
			expect((yield* readCheckpoint(sm.getBranch()))?.text).toBe("Second notes");
			sm.branch(firstCheckpoint);
			expect((yield* requireCheckpoint(sm.getBranch())).text).toBe("First notes");
			sm.appendCompaction("reset", firstCheckpoint, 50000);
			expect((yield* requireCheckpoint(sm.getBranch()).pipe(Effect.flip)).message).toContain(
				"Save a checkpoint",
			);
			expect((yield* readCheckpoint(sm.getBranch()))?.text).toBe("First notes");
		}),
	);

	it.effect(
		"fails safely on malformed persisted notes without exposing their content in errors",
		() =>
			Effect.gen(function* () {
				const sm = SessionManager.inMemory();
				ask(sm, "Request");
				sm.appendCustomEntry(CHECKPOINT_ENTRY, { text: "private-content", version: 999 });
				const error = yield* readCheckpoint(sm.getBranch()).pipe(Effect.flip);
				expect(error.reason).toContain("invalid");
				expect(JSON.stringify(error)).not.toContain("private-content");
			}),
	);

	it.effect("provides exact recovery references even without a checkpoint", () =>
		Effect.sync(() => {
			const sm = SessionManager.inMemory();
			const user = ask(sm, "Important user request");
			const seed = recoverySeed(sm.getBranch(), undefined);
			expect(seed).toContain(user);
			expect(seed).toContain("No saved checkpoint");
			expect(seed).toContain("context_history");
		}),
	);
});
