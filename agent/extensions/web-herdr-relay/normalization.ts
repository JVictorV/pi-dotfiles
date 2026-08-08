/** Maximum text retained from one Pi field before relay serialization. */
export const MAXIMUM_RELAY_TEXT_LENGTH = 16_000;

/** Maximum UTF-8 size of one normalized active-branch snapshot. */
export const MAXIMUM_RELAY_SNAPSHOT_BYTES = 1_500_000;

/** A browser-safe transcript message. */
export type RelayMessage = {
	readonly compaction?: { readonly tokensBefore: number };
	readonly id: string;
	readonly images?: ReadonlyArray<{
		readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	}>;
	readonly isError?: boolean;
	readonly role: "user" | "assistant" | "tool" | "system";
	readonly text: string;
	readonly thinking?: string;
	readonly timestamp: number;
	readonly toolCallId?: string;
};

/** A browser-safe tool execution. */
export type RelayTool = {
	readonly detail?: string;
	readonly id: string;
	readonly input?: string;
	readonly isError?: boolean;
	readonly name: string;
	readonly status: "running" | "complete";
	readonly timestamp: number;
};

/** A normalized active Pi branch. */
export type RelaySnapshot = {
	readonly messages: ReadonlyArray<RelayMessage>;
	readonly tools: ReadonlyArray<RelayTool>;
};

/** Limit text without splitting surrogate pairs or retaining control sequences. */
export function boundedText(
	value: string,
	maximum = MAXIMUM_RELAY_TEXT_LENGTH,
	sessionPaths: ReadonlyArray<string> = [],
): string {
	const withoutControls = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
	const withoutSessionPaths = sessionPaths.reduce(
		(text, path) => (path.length === 0 ? text : text.replaceAll(path, "[redacted session path]")),
		withoutControls,
	);
	const normalized = withoutSessionPaths.replace(
		/full output saved to:\s*[^\s)\]}>,]+/giu,
		"full output saved to: [redacted output path]",
	);
	return Array.from(normalized).slice(0, maximum).join("");
}

/** Extract safe text blocks and ignore image bytes, signatures, and unknown metadata. */
export function extractText(value: unknown, sessionPaths: ReadonlyArray<string> = []): string {
	if (typeof value === "string") {
		return boundedText(value, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths);
	}
	if (!Array.isArray(value)) {
		return "";
	}
	return boundedText(
		value
			.flatMap((block) => {
				const record = asRecord(block);
				return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
			})
			.join(""),
		MAXIMUM_RELAY_TEXT_LENGTH,
		sessionPaths,
	);
}

function extractImageMetadata(
	value: unknown,
): ReadonlyArray<{ readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp" }> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.flatMap((block) => {
			const record = asRecord(block);
			return record?.type === "image" && isImageMimeType(record.mimeType)
				? [{ mimeType: record.mimeType }]
				: [];
		})
		.slice(0, 4);
}

/** Extract safe assistant thinking blocks without provider payloads or signatures. */
export function extractThinking(
	value: unknown,
	sessionPaths: ReadonlyArray<string> = [],
): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const thinking = boundedText(
		value
			.flatMap((block) => {
				const record = asRecord(block);
				return record?.type === "thinking" && typeof record.thinking === "string"
					? [record.thinking]
					: [];
			})
			.join(""),
		MAXIMUM_RELAY_TEXT_LENGTH,
		sessionPaths,
	);
	return thinking.length === 0 ? undefined : thinking;
}

/** Normalize a persisted or streaming Pi message for browser display. */
export function normalizeMessage(
	id: string,
	message: unknown,
	fallbackTimestamp: number,
	sessionPaths: ReadonlyArray<string> = [],
): RelayMessage | undefined {
	const record = asRecord(message);
	if (record === undefined || typeof record.role !== "string") {
		return undefined;
	}
	const timestamp = numberOr(record.timestamp, fallbackTimestamp);
	if (record.role === "user") {
		const images = extractImageMetadata(record.content);
		return createMessage(
			id,
			"user",
			extractText(record.content, sessionPaths),
			timestamp,
			images.length === 0 ? undefined : { images },
		);
	}
	if (record.role === "assistant") {
		const thinking = extractThinking(record.content, sessionPaths);
		return createMessage(
			id,
			"assistant",
			extractText(record.content, sessionPaths),
			timestamp,
			thinking === undefined ? undefined : { thinking },
		);
	}
	if (record.role === "toolResult") {
		const toolCallId = stringOrUndefined(record.toolCallId);
		return createMessage(
			id,
			"tool",
			extractText(record.content, sessionPaths),
			timestamp,
			toolCallId === undefined
				? { isError: record.isError === true }
				: { isError: record.isError === true, toolCallId },
		);
	}
	if (record.role === "custom" && record.display === true) {
		return createMessage(id, "system", extractText(record.content, sessionPaths), timestamp);
	}
	return undefined;
}

/** Serialize bounded tool input while omitting values that are not JSON data. */
export function serializeToolInput(
	input: unknown,
	sessionPaths: ReadonlyArray<string> = [],
): string | undefined {
	try {
		const serialized = JSON.stringify(input, undefined, 2);
		return serialized === undefined
			? undefined
			: boundedText(serialized, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths);
	} catch {
		return undefined;
	}
}

/** Normalize tool calls and their browser-safe input from an assistant message. */
export function normalizeToolCalls(
	message: unknown,
	fallbackTimestamp: number,
	sessionPaths: ReadonlyArray<string> = [],
): ReadonlyArray<RelayTool> {
	const record = asRecord(message);
	if (record === undefined || !Array.isArray(record.content)) {
		return [];
	}
	const timestamp = numberOr(record.timestamp, fallbackTimestamp);
	return record.content.flatMap((block) => {
		const toolCall = asRecord(block);
		if (
			toolCall?.type !== "toolCall" ||
			typeof toolCall.id !== "string" ||
			typeof toolCall.name !== "string"
		) {
			return [];
		}
		const input = serializeToolInput(toolCall.arguments, sessionPaths);
		return [
			{
				id: boundedIdentifier(toolCall.id, "tool"),
				...(input === undefined ? {} : { input }),
				name: boundedText(toolCall.name, 128),
				status: "running" as const,
				timestamp,
			},
		];
	});
}

/** Build a bounded snapshot from `buildContextEntries()` without reading session JSONL. */
export function normalizeActiveBranch(
	entries: unknown,
	fallbackTimestamp: number,
	sessionPaths: ReadonlyArray<string> = [],
): RelaySnapshot {
	if (!Array.isArray(entries)) {
		return { messages: [], tools: [] };
	}

	const messages: RelayMessage[] = [];
	const tools = new Map<string, RelayTool>();
	for (const record of retainRenderableEntries(entries)) {
		const timestamp = timestampForEntry(record, fallbackTimestamp);
		if (record.type === "message") {
			const message = normalizeMessage(
				boundedIdentifier(record.id, "entry"),
				record.message,
				timestamp,
				sessionPaths,
			);
			if (
				message !== undefined &&
				(message.text.length > 0 || message.thinking !== undefined || message.images !== undefined)
			) {
				messages.push(message);
			}
			for (const tool of normalizeToolCalls(record.message, timestamp, sessionPaths)) {
				tools.set(tool.id, tool);
			}
			const persisted = asRecord(record.message);
			if (persisted?.role === "toolResult" && typeof persisted.toolCallId === "string") {
				const toolId = boundedIdentifier(persisted.toolCallId, "tool");
				const current = tools.get(toolId);
				tools.set(toolId, {
					detail: extractText(persisted.content, sessionPaths),
					id: toolId,
					...(current?.input === undefined ? {} : { input: current.input }),
					isError: persisted.isError === true,
					name: current?.name ?? boundedText(String(persisted.toolName ?? "tool"), 128),
					status: "complete",
					timestamp,
				});
			}
			continue;
		}
		if (record.type === "custom_message" && record.display === true) {
			const text = extractText(record.content, sessionPaths);
			if (text.length > 0) {
				messages.push({
					id: boundedIdentifier(record.id, "custom"),
					role: "system",
					text,
					timestamp,
				});
			}
			continue;
		}
		if (record.type === "compaction" && typeof record.summary === "string") {
			const tokensBefore = nonnegativeSafeInteger(record.tokensBefore);
			messages.push({
				...(tokensBefore === undefined ? {} : { compaction: { tokensBefore } }),
				id: boundedIdentifier(record.id, "compaction"),
				role: "system",
				text: boundedText(record.summary, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths),
				timestamp,
			});
			continue;
		}
		if (record.type === "branch_summary" && typeof record.summary === "string") {
			messages.push({
				id: boundedIdentifier(record.id, "branch"),
				role: "system",
				text: boundedText(record.summary, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths),
				timestamp,
			});
		}
	}

	const chronologicalMessages = [...messages].sort(
		(left, right) => left.timestamp - right.timestamp,
	);
	const chronologicalTools = [...tools.values()].sort(
		(left, right) => left.timestamp - right.timestamp,
	);
	return boundSnapshot(chronologicalMessages.slice(-240), chronologicalTools.slice(-80));
}

function retainRenderableEntries(
	entries: ReadonlyArray<unknown>,
): ReadonlyArray<Record<string, unknown> & { readonly id: string }> {
	const retained: Array<Record<string, unknown> & { readonly id: string }> = [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const record = asRecord(entries[index]);
		if (record === undefined || typeof record.id !== "string" || !isRenderableEntry(record)) {
			continue;
		}
		const isSummaryEntry = record.type === "compaction" || record.type === "branch_summary";
		if (retained.length >= 240 && !isSummaryEntry) {
			continue;
		}
		retained.unshift({ ...record, id: record.id });
	}
	return retained;
}

function isRenderableEntry(record: Record<string, unknown>): boolean {
	if (
		record.type === "compaction" ||
		record.type === "branch_summary" ||
		(record.type === "custom_message" && record.display === true)
	) {
		return true;
	}
	if (record.type !== "message") {
		return false;
	}
	const message = asRecord(record.message);
	return (
		message?.role === "user" ||
		message?.role === "assistant" ||
		message?.role === "toolResult" ||
		(message?.role === "custom" && message.display === true)
	);
}

/** Return a plain record only when the unknown value is an object. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

function boundSnapshot(
	messages: ReadonlyArray<RelayMessage>,
	tools: ReadonlyArray<RelayTool>,
): RelaySnapshot {
	const boundedMessages: RelayMessage[] = [];
	const boundedTools: RelayTool[] = [];
	let bytes = jsonSize({ messages: boundedMessages, tools: boundedTools });

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) {
			continue;
		}
		const additionalBytes = jsonSize(message) + (boundedMessages.length === 0 ? 0 : 1);
		if (bytes + additionalBytes > MAXIMUM_RELAY_SNAPSHOT_BYTES) {
			break;
		}
		boundedMessages.unshift(message);
		bytes += additionalBytes;
	}

	for (let index = tools.length - 1; index >= 0; index -= 1) {
		const tool = tools[index];
		if (tool === undefined) {
			continue;
		}
		const additionalBytes = jsonSize(tool) + (boundedTools.length === 0 ? 0 : 1);
		if (bytes + additionalBytes > MAXIMUM_RELAY_SNAPSHOT_BYTES) {
			break;
		}
		boundedTools.unshift(tool);
		bytes += additionalBytes;
	}

	return { messages: boundedMessages, tools: boundedTools };
}

function jsonSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createMessage(
	id: string,
	role: RelayMessage["role"],
	text: string,
	timestamp: number,
	extra?: Pick<RelayMessage, "images" | "isError" | "thinking" | "toolCallId">,
): RelayMessage {
	return {
		id: boundedIdentifier(id, "message"),
		role,
		text,
		timestamp,
		...(extra?.images === undefined ? {} : { images: extra.images }),
		...(extra?.thinking === undefined ? {} : { thinking: extra.thinking }),
		...(extra?.toolCallId === undefined
			? {}
			: { toolCallId: boundedIdentifier(extra.toolCallId, "tool") }),
		...(extra?.isError === undefined ? {} : { isError: extra.isError }),
	};
}

function timestampForEntry(record: Record<string, unknown>, fallback: number): number {
	if (typeof record.timestamp === "string") {
		const parsed = Date.parse(record.timestamp);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return parsed;
		}
	}
	return numberOr(record.timestamp, fallback);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isImageMimeType(
	value: unknown,
): value is "image/gif" | "image/jpeg" | "image/png" | "image/webp" {
	return (
		value === "image/gif" ||
		value === "image/jpeg" ||
		value === "image/png" ||
		value === "image/webp"
	);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedIdentifier(value: string, prefix: string): string {
	const normalized = boundedText(value, 120).trim();
	return normalized.length === 0 ? `${prefix}-unknown` : normalized;
}
