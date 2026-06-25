/**
 * Tool result safety guard.
 *
 * Anthropic rejects errored tool results whose content is empty. This extension
 * patches any such result before it is persisted or sent back to the model.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const textContent = (text: string): TextContent => ({ type: "text", text });

const hasNonEmptyContent = (content: ToolResultEvent["content"]): boolean =>
	content.some((block) => {
		if (block.type === "text") {
			return block.text.trim().length > 0;
		}

		return true;
	});

type ToolResultIdentity = {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: ToolResultEvent["content"];
	readonly isError: boolean;
};

const fallbackErrorContent = (toolResult: ToolResultIdentity): TextContent =>
	textContent(
		`Tool "${toolResult.toolName}" failed without producing error output (toolCallId: ${toolResult.toolCallId}).`,
	);

const sanitizeErrorContent = (
	toolResult: ToolResultIdentity,
): ToolResultEvent["content"] | undefined => {
	if (!toolResult.isError || hasNonEmptyContent(toolResult.content)) {
		return undefined;
	}

	return [fallbackErrorContent(toolResult)];
};

/**
 * Register a guard that ensures failed tool results always have non-empty content.
 *
 * @param pi - The pi extension API.
 */
export default function toolResultSanitizerExtension(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		const content = sanitizeErrorContent(event);
		return content === undefined ? undefined : { content };
	});

	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "toolResult") {
				return message;
			}

			const content = sanitizeErrorContent(message);
			if (content === undefined) {
				return message;
			}

			changed = true;
			return { ...message, content };
		});

		return changed ? { messages } : undefined;
	});
}
