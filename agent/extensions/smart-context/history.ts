import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Match, Schema } from "effect";

/** A safe, classified failure from the smart-context tools. */
export class SmartContextError extends Schema.TaggedError<SmartContextError>()(
	"SmartContextError",
	{ operation: Schema.String, reason: Schema.String },
) {
	override get message(): string {
		return this.reason;
	}
}

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }));
const WindowFilter = Schema.optionalKey(Schema.NonEmptyString);
const HistoryRequest = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("list"),
		snapshotId: WindowFilter,
		windowId: WindowFilter,
		offset: Schema.optionalKey(Offset),
		limit: Schema.optionalKey(PageSize),
	}),
	Schema.Struct({
		action: Schema.Literal("search"),
		snapshotId: WindowFilter,
		query: Schema.NonEmptyString.check(Schema.isMaxLength(500)),
		windowId: WindowFilter,
		offset: Schema.optionalKey(Offset),
		limit: Schema.optionalKey(PageSize),
	}),
	Schema.Struct({
		action: Schema.Literal("read"),
		id: Schema.NonEmptyString,
		offset: Schema.optionalKey(Offset),
		limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8000 }))),
	}),
]);

const parseHistoryRequest = Schema.decodeUnknownEffect(HistoryRequest);

/** Text that is recoverable from the active branch. Thinking and opaque metadata are excluded. */
export type HistoryItem = {
	readonly id: string;
	readonly windowId: string;
	readonly role: string;
	readonly text: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly exitCode?: number | null;
	readonly cancelled?: boolean;
	readonly truncated?: boolean;
	readonly stopReason?: string;
};

/** Build a read-only archive from the active branch, including entries before compaction. */
export function historyItems(branch: readonly SessionEntry[]): HistoryItem[] {
	let windowId = "initial";
	const items: HistoryItem[] = [];
	for (const entry of branch) {
		if (entry.type === "compaction") {
			windowId = entry.id;
			items.push({ id: entry.id, windowId, role: "checkpoint", text: entry.summary });
		} else if (entry.type === "branch_summary") {
			items.push({ id: entry.id, windowId, role: "branchSummary", text: entry.summary });
		} else if (entry.type === "custom_message") {
			const text =
				typeof entry.content === "string"
					? entry.content
					: entry.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
			items.push({ id: entry.id, windowId, role: "custom", text });
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "bashExecution") {
				if (!message.excludeFromContext)
					items.push({
						id: entry.id,
						windowId,
						role: "bash",
						text: `${message.command}\n${message.output}`,
						exitCode: message.exitCode ?? null,
						cancelled: message.cancelled,
						truncated: message.truncated,
					});
				continue;
			}
			if (message.role === "compactionSummary" || message.role === "branchSummary") {
				items.push({ id: entry.id, windowId, role: message.role, text: message.summary });
				continue;
			}
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.flatMap((part) =>
								Match.value(part).pipe(
									Match.when({ type: "text" }, (part) => [part.text]),
									Match.when({ type: "image" }, () => [
										"[image: inspect the original source again if needed]",
									]),
									Match.when({ type: "toolCall" }, (part) => [
										`Tool ${part.name}: ${JSON.stringify(part.arguments)}`,
									]),
									Match.when({ type: "thinking" }, () => []),
									Match.exhaustive,
								),
							)
							.join("\n");
			items.push({
				id: entry.id,
				windowId,
				role: message.role,
				text,
				...(message.role === "toolResult"
					? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError }
					: {}),
				...(message.role === "assistant" ? { stopReason: message.stopReason } : {}),
			});
		}
	}
	return items;
}

type ReadChunk = HistoryItem & {
	readonly kind: "read";
	readonly offset: number;
	readonly nextOffset: number | null;
	readonly totalCharacters: number;
};
type HistoryPage = {
	readonly kind: "page";
	readonly snapshotId: string | null;
	readonly items: readonly {
		readonly id: string;
		readonly windowId: string;
		readonly role: string;
		readonly preview: string;
	}[];
	readonly nextOffset: number | null;
	readonly total: number;
};

/** Read bounded original text, or paginate newest-first literal search/list results. */
export const queryHistory = Effect.fn("SmartContext.queryHistory")(function* (
	branch: readonly SessionEntry[],
	input: unknown,
) {
	const request = yield* parseHistoryRequest(input).pipe(
		Effect.mapError(
			() =>
				new SmartContextError({
					operation: "history",
					reason:
						"Invalid history request. Supply an id for read or a nonempty query for search. List/search limits are 1–30; read limits are 1–8000.",
				}),
		),
	);
	const offset = request.offset ?? 0;
	if (request.action !== "read" && offset > 0 && !request.snapshotId) {
		return yield* new SmartContextError({
			operation: "history",
			reason: "Supply the returned snapshotId when continuing a list/search page with offset.",
		});
	}
	const snapshotId = request.action === "read" ? undefined : request.snapshotId;
	const snapshotIndex =
		snapshotId === undefined
			? branch.length - 1
			: branch.findIndex((entry) => entry.id === snapshotId);
	if (snapshotId !== undefined && snapshotIndex < 0)
		return yield* new SmartContextError({
			operation: "history",
			reason: "History snapshot not found on the active branch.",
		});
	const items = historyItems(branch.slice(0, snapshotIndex + 1));
	if (request.action === "read") {
		const item = items.find((candidate) => candidate.id === request.id);
		if (!item)
			return yield* new SmartContextError({
				operation: "history",
				reason: "History item not found on the active branch.",
			});
		const text = item.text.slice(offset, offset + (request.limit ?? 4000));
		return {
			kind: "read",
			...item,
			text,
			offset,
			nextOffset: offset + text.length < item.text.length ? offset + text.length : null,
			totalCharacters: item.text.length,
		} satisfies ReadChunk;
	}
	const matches = items
		.filter(
			(item) =>
				(request.windowId === undefined || item.windowId === request.windowId) &&
				(request.action === "list" || item.text.includes(request.query)),
		)
		.reverse();
	const page = matches.slice(offset, offset + (request.limit ?? 10));
	return {
		kind: "page",
		snapshotId: branch[snapshotIndex]?.id ?? null,
		items: page.map((item) => {
			const start =
				request.action === "search" ? Math.max(0, item.text.indexOf(request.query) - 60) : 0;
			const { text, ...metadata } = item;
			return { ...metadata, preview: text.slice(start, start + 200) };
		}),
		nextOffset: offset + page.length < matches.length ? offset + page.length : null,
		total: matches.length,
	} satisfies HistoryPage;
});
