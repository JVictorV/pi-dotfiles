import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import toolResultSanitizerExtension from "../agent/extensions/tool-result-sanitizer";

type ToolResultPatch = {
	readonly content?: ToolResultEvent["content"];
	readonly details?: unknown;
	readonly isError?: boolean;
};

type ToolResultHandler = ExtensionHandler<ToolResultEvent, ToolResultPatch>;

type ContextToolResultMessage = {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: ToolResultEvent["content"];
	readonly details?: unknown;
	readonly isError: boolean;
	readonly timestamp: number;
};

type ContextUserMessage = {
	readonly role: "user";
	readonly content: string;
	readonly timestamp: number;
};

type ContextMessage = ContextToolResultMessage | ContextUserMessage;

type ContextPatch = {
	readonly messages?: ReadonlyArray<ContextMessage>;
};

type ContextHandler = (
	event: { readonly type: "context"; readonly messages: ReadonlyArray<ContextMessage> },
	ctx: ExtensionContext,
) => ContextPatch | Promise<ContextPatch | void> | void;

type CapturedHandlers = {
	readonly toolResult: ToolResultHandler;
	readonly context: ContextHandler;
};

function registerToolResultSanitizer(): CapturedHandlers {
	let toolResult: ToolResultHandler | undefined;
	let context: ContextHandler | undefined;
	// SAFETY: Registering the tool-result sanitizer only requires this subset of ExtensionAPI.
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_result") {
				// SAFETY: The sanitizer registers a ToolResultHandler for the tool_result event.
				toolResult = handler as ToolResultHandler;
			}
			if (event === "context") {
				// SAFETY: The sanitizer registers a ContextHandler for the context event.
				context = handler as ContextHandler;
			}
		},
	} as unknown as ExtensionAPI;

	toolResultSanitizerExtension(pi);
	if (toolResult === undefined) throw new Error("tool_result handler was not registered");
	if (context === undefined) throw new Error("context handler was not registered");
	return { toolResult, context };
}

// SAFETY: The sanitizer handler does not read ExtensionContext in these focused tests.
const ctx = {} as unknown as ExtensionContext;

const stackToolResult = (content: ToolResultEvent["content"], isError = true): ToolResultEvent => ({
	type: "tool_result",
	toolCallId: "toolu_test",
	toolName: "stack",
	input: {},
	content,
	isError,
	details: {},
});

describe("tool result sanitizer", () => {
	test("fills empty errored tool results with fallback text", async () => {
		const { toolResult } = registerToolResultSanitizer();

		await expect(
			Promise.resolve(toolResult(stackToolResult([{ type: "text", text: "" }]), ctx)),
		).resolves.toEqual({
			content: [
				{
					type: "text",
					text: 'Tool "stack" failed without producing error output (toolCallId: toolu_test).',
				},
			],
		});
	});

	test("leaves non-empty and non-error results unchanged", async () => {
		const { toolResult } = registerToolResultSanitizer();

		await expect(
			Promise.resolve(toolResult(stackToolResult([{ type: "text", text: "actual error" }]), ctx)),
		).resolves.toBeUndefined();
		await expect(
			Promise.resolve(toolResult(stackToolResult([{ type: "text", text: "" }], false), ctx)),
		).resolves.toBeUndefined();
	});

	test("sanitizes historical empty errored tool results before provider context is sent", async () => {
		const { context } = registerToolResultSanitizer();
		const toolResultMessage: ContextToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_old",
			toolName: "stack",
			content: [{ type: "text", text: "" }],
			isError: true,
			timestamp: 1,
		};
		const userMessage: ContextUserMessage = { role: "user", content: "continue", timestamp: 2 };

		await expect(
			Promise.resolve(
				context({ type: "context", messages: [toolResultMessage, userMessage] }, ctx),
			),
		).resolves.toEqual({
			messages: [
				{
					...toolResultMessage,
					content: [
						{
							type: "text",
							text: 'Tool "stack" failed without producing error output (toolCallId: toolu_old).',
						},
					],
				},
				userMessage,
			],
		});
		expect(toolResultMessage.content).toEqual([{ type: "text", text: "" }]);
	});
});
