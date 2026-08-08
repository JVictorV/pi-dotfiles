import { describe, expect, it } from "vitest";
import { applyRemoteHistoryPayloadPatch } from "./openai.ts";
import {
  applyHttpContinuationPayloadPatch,
  selectInputItemsForContinuation,
} from "./openai-ws-stream.ts";
import type { RemoteCompactionSessionState, ResponseItem } from "./remote-compaction.ts";

const TARGET_MODEL_KEY = "openai:openai-responses:gpt-5.6-sol";
const REPLAY_HISTORY: ResponseItem[] = [
  { type: "compaction", encrypted_content: "opaque-checkpoint" },
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "post-checkpoint request" }],
  },
];
const REMOTE_STATE: RemoteCompactionSessionState = {
  compactionEntryId: "cmp-1",
  modelKey: TARGET_MODEL_KEY,
  replacementHistory: [REPLAY_HISTORY[0]],
  explicitHistory: REPLAY_HISTORY,
};
const PORTABLE_CONTEXT = {
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "portable fallback context" }],
      timestamp: 1,
    },
  ],
};

describe("provider replay payloads", () => {
  it("patches OpenAI Codex requests with artifact-first explicit history", () => {
    const payload = applyRemoteHistoryPayloadPatch({
      payload: {
        model: "gpt-5.6-sol",
        messages: ["portable"],
        input: ["portable"],
        previous_response_id: "resp-old",
      },
      explicitHistory: REPLAY_HISTORY,
    });

    expect(payload.input).toEqual(REPLAY_HISTORY);
    expect(payload).not.toHaveProperty("messages");
    expect(payload).not.toHaveProperty("previous_response_id");
  });

  it("selects artifact-first explicit history for direct OpenAI WebSocket replay", () => {
    const input = selectInputItemsForContinuation({
      context: PORTABLE_CONTEXT,
      model: { input: ["text"] },
      session: { lastContextLength: 1 },
      currentModelKey: TARGET_MODEL_KEY,
      remoteCompactionState: REMOTE_STATE,
      previousResponseId: "resp-old",
    });

    expect(input).toEqual(REPLAY_HISTORY);
  });

  it("patches direct OpenAI HTTP fallback with artifact-first explicit history", () => {
    const payload = applyHttpContinuationPayloadPatch({
      payload: {
        model: "gpt-5.6-sol",
        messages: ["portable"],
        input: ["portable"],
        previous_response_id: "resp-old",
      },
      context: PORTABLE_CONTEXT,
      model: { input: ["text"] },
      currentModelKey: TARGET_MODEL_KEY,
      remoteCompactionState: REMOTE_STATE,
      continuationState: undefined,
    });

    expect(payload).toEqual({
      model: "gpt-5.6-sol",
      input: REPLAY_HISTORY,
    });
  });
});
