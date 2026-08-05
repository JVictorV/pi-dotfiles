import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import openaiServerCompactionExtension from "./index.ts";
import { getContinuationState } from "./state.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type EventHandler = (event: unknown, ctx: unknown) => unknown;

const requiredHandler = (
	handlers: ReadonlyMap<string, ReadonlyArray<EventHandler>>,
	event: string,
): EventHandler => {
	const handler = handlers.get(event)?.[0];
	if (!handler) {
		throw new Error(`Missing ${event} handler`);
	}
	return handler;
};

describe("vendored OpenAI server compaction extension", () => {
	it("loads its auto-discovered entrypoint", () => {
		expect(openaiServerCompactionExtension).toBeTypeOf("function");
	});

	it("puts a newly injected custom message in the next remote provider request", async () => {
		const handlers = new Map<string, EventHandler[]>();
		const branch: Array<Record<string, unknown>> = [
			{
				type: "compaction",
				id: "cmp-1",
				details: {
					remoteCompaction: {
						version: 2,
						provider: "openai-responses-compaction",
						modelKey: "openai-codex:openai-codex-responses:gpt-5.6-sol",
						replacementHistory: [
							{ type: "compaction", encrypted_content: "opaque-checkpoint" },
						],
					},
				},
			},
		];
		let nextEntry = 1;
		const fakePi = {
			registerProvider() {},
			on(event: string, handler: EventHandler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: {
				readonly customType: string;
				readonly content: string;
				readonly display: boolean;
			}) {
				branch.push({
					type: "custom_message",
					id: `custom-${nextEntry}`,
					parentId: "cmp-1",
					timestamp: "2026-08-05T00:00:00.000Z",
					...message,
				});
				nextEntry += 1;
			},
		};
		// SAFETY: This test fake implements every ExtensionAPI method used during extension
		// registration and by the session/provider events dispatched below.
		openaiServerCompactionExtension(fakePi as unknown as ExtensionAPI);
		const model = {
			id: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			input: ["text"],
		};
		const ctx = {
			cwd: "/tmp/openai-server-compaction-test",
			model,
			hasUI: false,
			ui: { notify() {} },
			sessionManager: {
				getSessionId: () => "session-custom-message",
				getBranch: () => branch,
			},
		};
		const content = '<subagent_result state="done">the exact final report</subagent_result>';

		try {
			requiredHandler(handlers, "session_start")({ reason: "startup" }, ctx);
			fakePi.sendMessage({
				customType: "herdr-subagent-result",
				content,
				display: true,
			});

			const result = await requiredHandler(handlers, "before_provider_request")(
				{ payload: { model: "gpt-5.6-sol", input: [] } },
				ctx,
			);

			const expectedInput = [
				{ type: "compaction", encrypted_content: "opaque-checkpoint" },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: content }],
				},
			];
			expect(isRecord(result) ? result.input : undefined).toEqual(expectedInput);

			requiredHandler(handlers, "session_shutdown")({}, ctx);
			requiredHandler(handlers, "session_start")({ reason: "reload" }, ctx);
			const reconstructedResult = await requiredHandler(
				handlers,
				"before_provider_request",
			)({ payload: { model: "gpt-5.6-sol", input: [] } }, ctx);
			expect(isRecord(reconstructedResult) ? reconstructedResult.input : undefined).toEqual(
				expectedInput,
			);
		} finally {
			requiredHandler(handlers, "session_shutdown")({}, ctx);
		}
	});

	it("counts the current assistant and custom entries in continuation context", () => {
		const handlers = new Map<string, EventHandler[]>();
		const branch: Array<Record<string, unknown>> = [
			{
				type: "message",
				id: "user-1",
				message: { role: "user", content: [{ type: "text", text: "request" }], timestamp: 1 },
			},
			{
				type: "custom_message",
				id: "custom-1",
				parentId: "user-1",
				timestamp: "2026-08-05T00:00:00.000Z",
				customType: "herdr-subagent-result",
				content: "custom context",
				display: true,
			},
		];
		const fakePi = {
			registerProvider() {},
			on(event: string, handler: EventHandler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		};
		// SAFETY: This test fake implements every ExtensionAPI method used during extension
		// registration and by the lifecycle events dispatched below.
		openaiServerCompactionExtension(fakePi as unknown as ExtensionAPI);
		const sessionId = "session-context-length";
		const model = {
			id: "gpt-5.6-sol",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
		};
		const ctx = {
			cwd: "/tmp/openai-server-compaction-test",
			model,
			hasUI: false,
			ui: { notify() {} },
			sessionManager: {
				getSessionId: () => sessionId,
				getBranch: () => branch,
				buildContextEntries: () => branch,
			},
		};

		try {
			requiredHandler(handlers, "session_start")({ reason: "startup" }, ctx);
			requiredHandler(handlers, "message_end")(
				{
					message: {
						role: "assistant",
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.6-sol",
						responseId: "resp-current",
						content: [{ type: "text", text: "answer" }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: 2,
					},
				},
				ctx,
			);

			expect(getContinuationState(sessionId)?.contextLength).toBe(3);
		} finally {
			requiredHandler(handlers, "session_shutdown")({}, ctx);
		}
	});
});
