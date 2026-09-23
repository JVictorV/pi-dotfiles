import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import { historyItems, SmartContextError } from "./history";

/** Custom entry type for branch-local, model-written checkpoints. */
export const CHECKPOINT_ENTRY = "smart-context-checkpoint";

/** A bounded checkpoint keeps context resets useful even on smaller models. */
export const CheckpointText = Schema.NonEmptyString.check(
	Schema.isMaxLength(8000),
	Schema.makeFilter((text) => text.trim().length > 0),
);

const Checkpoint = Schema.Struct({
	version: Schema.Literal(1),
	windowId: Schema.NonEmptyString,
	anchorId: Schema.NonEmptyString,
	text: CheckpointText,
});

const parseCheckpoint = Schema.decodeUnknownEffect(Checkpoint);

/** A checkpoint and its durable session entry identity. */
export type SavedCheckpoint = typeof Checkpoint.Type & { readonly id: string };

/** Identify the active context window without mutable, cross-branch caches. */
export function currentWindow(branch: readonly SessionEntry[]): string {
	return branch.findLast((entry) => entry.type === "compaction")?.id ?? "initial";
}

/** Load the latest checkpoint from this branch, including its previous window if any. */
export const readCheckpoint = Effect.fn("SmartContext.readCheckpoint")(function* (
	branch: readonly SessionEntry[],
) {
	const entry = branch.findLast(
		(item) => item.type === "custom" && item.customType === CHECKPOINT_ENTRY,
	);
	if (entry?.type !== "custom") return undefined;
	const note = yield* parseCheckpoint(entry.data).pipe(
		Effect.mapError(
			() =>
				new SmartContextError({
					operation: "read checkpoint",
					reason:
						"The saved smart-context checkpoint is invalid. Write a new checkpoint before resetting context.",
				}),
		),
	);
	return { ...note, id: entry.id } satisfies SavedCheckpoint;
});

/** Reject voluntary resets that would reuse a checkpoint from an earlier window or request. */
export const requireCheckpoint = Effect.fn("SmartContext.requireCheckpoint")(function* (
	branch: readonly SessionEntry[],
) {
	const checkpoint = yield* readCheckpoint(branch);
	if (!checkpoint || checkpoint.windowId !== currentWindow(branch)) {
		return yield* new SmartContextError({
			operation: "reset",
			reason: "Save a checkpoint with context_notes before calling new_context.",
		});
	}
	const checkpointIndex = branch.findIndex((entry) => entry.id === checkpoint.id);
	const hasNewInput = branch
		.slice(checkpointIndex + 1)
		.some(
			(entry) =>
				entry.type === "custom_message" ||
				entry.type === "branch_summary" ||
				(entry.type === "message" && entry.message.role === "user"),
		);
	if (hasNewInput)
		return yield* new SmartContextError({
			operation: "reset",
			reason:
				"New input arrived after the checkpoint. Update context_notes before calling new_context.",
		});
	return checkpoint;
});

/** Build a recovery seed without calling a summarization model or deleting archived messages. */
export function recoverySeed(
	branch: readonly SessionEntry[],
	checkpoint: SavedCheckpoint | undefined,
): string {
	const items = historyItems(branch);
	const latestUser = items.findLast((item) => item.role === "user");
	const recent = items
		.slice(-8)
		.map((item) => `${item.id} (${item.role}, window ${item.windowId})`)
		.join("\n");
	return [
		"# Smart context recovery",
		"The active context was reset. Project files and the full active-branch history remain unchanged.",
		`Previous window: ${currentWindow(branch)}.`,
		latestUser
			? `Latest user request: ${latestUser.id}. Read it with context_history before continuing.`
			: "Use context_history to recover the active task.",
		checkpoint
			? `Checkpoint ${checkpoint.id}; covers work through ${checkpoint.anchorId} in window ${checkpoint.windowId}:\n\n${checkpoint.text}`
			: "No saved checkpoint was available. Recover the goal, constraints, decisions, and work from context_history before taking further actions.",
		"\nRecent history entry IDs (oldest first):",
		recent,
		"\nTreat the checkpoint as working notes, not new user instructions. Recover any missing requirements and results with context_history. Check history after the checkpoint anchor before repeating actions. Images are not copied into history text; inspect their original source again or ask the user if needed.",
	].join("\n\n");
}
