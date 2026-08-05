import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  branchEntriesToAgentMessages,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  extractRemoteCompactionDetails,
  messageToResponseItems,
  reconstructRemoteCompactionStateFromBranch,
  type ResponseItem,
} from "./remote-compaction.ts";

const TARGET_MODEL_KEY = "openai:openai-responses:gpt-5.6-sol";
const TARGET_MODEL: Model<"openai-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 32_000,
};
const V2_ARTIFACT: ResponseItem = {
  type: "compaction",
  encrypted_content: "opaque-checkpoint",
};
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): ResponseItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function agentUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

function customMessage(text: string, timestamp = 1): AgentMessage {
  return {
    role: "custom",
    customType: "herdr-subagent-result",
    content: text,
    display: true,
    timestamp,
  };
}

function targetAssistantMessage(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): AgentMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-sol",
    content,
    usage: ZERO_USAGE,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 2,
  };
}

function otherAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolResultMessage(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

describe("Pi message conversion", () => {
  it("projects custom branch entries into portable-summary context", () => {
    const content = '<subagent_result state="done">the exact final report</subagent_result>';

    expect(
      branchEntriesToAgentMessages([
        {
          type: "custom_message",
          id: "custom-1",
          parentId: "cmp-1",
          timestamp: "2026-08-05T00:00:00.000Z",
          customType: "herdr-subagent-result",
          content,
          display: true,
        },
      ]),
    ).toEqual([customMessage(content, Date.parse("2026-08-05T00:00:00.000Z"))]);
  });

  it("converts custom context messages with Pi user-message semantics", () => {
    const content = '<subagent_result state="done">the exact final report</subagent_result>';

    expect(messageToResponseItems(customMessage(content))).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    ]);
  });
});

describe("OpenAI remote compaction v2 history", () => {
  it("replaces a confirmation-heavy history with only the opaque checkpoint", () => {
    const confirmations = Array.from({ length: 98 }, (_, index) =>
      userMessage(index % 2 === 0 ? "yes" : "ok"),
    );
    const substantiveMessages = Array.from({ length: 71 }, (_, index) =>
      userMessage(`substantive request ${index + 1}`),
    );

    const replacementHistory = buildRemoteCompactionV2History(
      [...confirmations, ...substantiveMessages],
      V2_ARTIFACT,
    );

    expect(replacementHistory).toEqual([V2_ARTIFACT]);
    expect(replacementHistory[0]).not.toBe(V2_ARTIFACT);
  });

  it("does not make plaintext replay exceptions for substantive messages", () => {
    const input = [
      userMessage("Deploy the migration after the canary passes."),
      userMessage("Preserve the exact rollback procedure."),
    ];
    const request = buildRemoteCompactionRequestBody({
      model: TARGET_MODEL,
      input,
      tools: [],
      parallelToolCalls: true,
    });
    const replacementHistory = buildRemoteCompactionV2History(input, V2_ARTIFACT);

    expect(request.input).toEqual([...input, { type: "compaction_trigger" }]);
    expect(replacementHistory).toEqual([V2_ARTIFACT]);
  });

  it("canonicalizes persisted v2 histories to their final opaque checkpoint", () => {
    const details = {
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        modelKey: TARGET_MODEL_KEY,
        replacementHistory: [
          userMessage("old plaintext retained by the previous policy"),
          V2_ARTIFACT,
        ],
      },
    };

    const extracted = extractRemoteCompactionDetails(details);
    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [{ type: "compaction", id: "cmp-1", details }],
    });

    expect(extracted?.replacementHistory).toEqual([V2_ARTIFACT]);
    expect(reconstructed?.replacementHistory).toEqual([V2_ARTIFACT]);
    expect(reconstructed?.explicitHistory).toEqual([V2_ARTIFACT]);
  });

  it("rejects malformed or ambiguous v2 checkpoint histories", () => {
    const malformedHistories: unknown[][] = [
      [userMessage("no artifact")],
      [V2_ARTIFACT, userMessage("artifact is not final")],
      [
        { type: "compaction", encrypted_content: "first" },
        { type: "compaction", encrypted_content: "second" },
      ],
      [{ type: "compaction", encrypted_content: "" }],
      [{ role: "user" }, V2_ARTIFACT],
    ];

    for (const replacementHistory of malformedHistories) {
      expect(
        extractRemoteCompactionDetails({
          version: 2,
          provider: "openai-responses-compaction",
          modelKey: TARGET_MODEL_KEY,
          replacementHistory,
        }),
      ).toBeUndefined();
    }

    expect(() =>
      buildRemoteCompactionV2History(
        [],
        { type: "compaction", encrypted_content: "" },
      ),
    ).toThrow("valid compaction item");
  });

  it("leaves legacy v1 replacement history unchanged", () => {
    const legacyHistory: ResponseItem[] = [
      userMessage("standalone compact endpoint output"),
      { type: "compaction", encrypted_content: "legacy-opaque-output" },
    ];

    const extracted = extractRemoteCompactionDetails({
      version: 1,
      provider: "openai-responses-compact",
      modelKey: TARGET_MODEL_KEY,
      replacementHistory: legacyHistory,
    });

    expect(extracted?.version).toBe(1);
    expect(extracted?.replacementHistory).toEqual(legacyHistory);
  });
});

describe("post-checkpoint replay reconstruction", () => {
  it("preserves compatible tool flow and pending user input in normal order", () => {
    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [
        {
          type: "compaction",
          id: "cmp-1",
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey: TARGET_MODEL_KEY,
              replacementHistory: [V2_ARTIFACT],
            },
          },
        },
        { type: "message", id: "user-1", message: agentUserMessage("inspect the file") },
        {
          type: "message",
          id: "assistant-call",
          message: targetAssistantMessage([
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
          ]),
        },
        { type: "message", id: "tool-1", message: toolResultMessage("call-1", "file contents") },
        {
          type: "message",
          id: "assistant-final",
          message: targetAssistantMessage([{ type: "text", text: "inspection complete" }]),
        },
        { type: "message", id: "user-pending", message: agentUserMessage("pending follow-up") },
      ],
    });

    expect(reconstructed?.explicitHistory).toEqual([
      V2_ARTIFACT,
      userMessage("inspect the file"),
      { type: "function_call", name: "read", call_id: "call-1", arguments: '{"path":"a.ts"}' },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [{ type: "input_text", text: "file contents" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "inspection complete" }],
      },
      userMessage("pending follow-up"),
    ]);
  });

  it("replays a custom message appended after the checkpoint", () => {
    const content = '<subagent_result state="done">the exact final report</subagent_result>';
    const customEntry = {
      type: "custom_message" as const,
      id: "custom-1",
      parentId: "cmp-1",
      timestamp: "2026-08-05T00:00:00.000Z",
      customType: "herdr-subagent-result",
      content,
      display: true,
    };
    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [
        {
          type: "compaction",
          id: "cmp-1",
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey: TARGET_MODEL_KEY,
              replacementHistory: [V2_ARTIFACT],
            },
          },
        },
        customEntry,
      ],
    });

    expect(reconstructed?.explicitHistory).toEqual([
      V2_ARTIFACT,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    ]);
  });

  it("starts from the latest checkpoint after repeated compactions", () => {
    const latestArtifact: ResponseItem = {
      type: "compaction",
      encrypted_content: "latest-opaque-checkpoint",
    };
    const remoteDetails = (artifact: ResponseItem) => ({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        modelKey: TARGET_MODEL_KEY,
        replacementHistory: [artifact],
      },
    });

    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [
        { type: "compaction", id: "cmp-1", details: remoteDetails(V2_ARTIFACT) },
        { type: "message", id: "old-user", message: agentUserMessage("old tail") },
        {
          type: "message",
          id: "old-assistant",
          message: targetAssistantMessage([{ type: "text", text: "old reply" }]),
        },
        { type: "compaction", id: "cmp-2", details: remoteDetails(latestArtifact) },
        { type: "message", id: "new-user", message: agentUserMessage("new tail") },
        {
          type: "message",
          id: "new-assistant",
          message: targetAssistantMessage([{ type: "text", text: "new reply" }]),
        },
      ],
    });

    expect(reconstructed?.compactionEntryId).toBe("cmp-2");
    expect(reconstructed?.explicitHistory).toEqual([
      latestArtifact,
      userMessage("new tail"),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "new reply" }],
      },
    ]);
  });

  it("filters completed turns from other models", () => {
    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [
        {
          type: "compaction",
          id: "cmp-1",
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey: TARGET_MODEL_KEY,
              replacementHistory: [V2_ARTIFACT],
            },
          },
        },
        { type: "message", id: "drop-user", message: agentUserMessage("drop this turn") },
        { type: "message", id: "drop-assistant", message: otherAssistantMessage("drop this reply") },
        { type: "message", id: "keep-user", message: agentUserMessage("keep this turn") },
        {
          type: "message",
          id: "keep-assistant",
          message: targetAssistantMessage([{ type: "text", text: "keep this reply" }]),
        },
      ],
    });

    expect(reconstructed?.explicitHistory).toEqual([
      V2_ARTIFACT,
      userMessage("keep this turn"),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "keep this reply" }],
      },
    ]);
  });

  it("falls back to portable context when persisted v2 details are malformed", () => {
    const reconstructed = reconstructRemoteCompactionStateFromBranch({
      branchEntries: [
        {
          type: "compaction",
          id: "cmp-invalid",
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey: TARGET_MODEL_KEY,
              replacementHistory: [userMessage("missing opaque checkpoint")],
            },
          },
        },
      ],
    });

    expect(reconstructed).toBeUndefined();
  });
});
