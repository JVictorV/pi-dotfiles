import { describe, expect, it } from "vitest";
import { resolveHybridCompactionResults } from "./index.ts";

const MODEL = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.6-sol",
};
const PORTABLE = {
  summary: "Meaningful portable summary",
  firstKeptEntryId: "kept-1",
  tokensBefore: 42_000,
  details: { readFiles: ["src/a.ts"], modifiedFiles: [] },
};
const REMOTE = {
  output: [{ type: "compaction" as const, encrypted_content: "opaque-checkpoint" }],
};
const PORTABLE_FAILURE: PromiseRejectedResult = {
  status: "rejected",
  reason: new Error("portable summary failed"),
};
const REMOTE_FAILURE: PromiseRejectedResult = {
  status: "rejected",
  reason: new Error("remote compaction failed"),
};

describe("hybrid compaction result resolution", () => {
  it("persists hybrid state when portable and remote compaction both succeed", () => {
    const result = resolveHybridCompactionResults({
      model: MODEL,
      localResult: { status: "fulfilled", value: PORTABLE },
      remoteResult: { status: "fulfilled", value: REMOTE },
    });

    expect(result).toEqual({
      compaction: {
        summary: PORTABLE.summary,
        firstKeptEntryId: PORTABLE.firstKeptEntryId,
        tokensBefore: PORTABLE.tokensBefore,
        details: {
          localSummaryDetails: PORTABLE.details,
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            implementation: "responses_compaction_v2",
            modelKey: "openai:openai-responses:gpt-5.6-sol",
            replacementHistory: REMOTE.output,
          },
        },
      },
    });
  });

  it("persists only the portable result when remote compaction fails", () => {
    const result = resolveHybridCompactionResults({
      model: MODEL,
      localResult: { status: "fulfilled", value: PORTABLE },
      remoteResult: REMOTE_FAILURE,
    });

    expect(result).toEqual({ compaction: PORTABLE });
  });

  it("defers to Pi when only the remote artifact is available", () => {
    const result = resolveHybridCompactionResults({
      model: MODEL,
      localResult: PORTABLE_FAILURE,
      remoteResult: { status: "fulfilled", value: REMOTE },
    });

    expect(result).toBeUndefined();
  });

  it("rejects empty portable summaries for every remote outcome", () => {
    const emptyPortable = {
      ...PORTABLE,
      summary: "  \n ",
    };

    expect(
      resolveHybridCompactionResults({
        model: MODEL,
        localResult: { status: "fulfilled", value: emptyPortable },
        remoteResult: { status: "fulfilled", value: REMOTE },
      }),
    ).toBeUndefined();
    expect(
      resolveHybridCompactionResults({
        model: MODEL,
        localResult: { status: "fulfilled", value: emptyPortable },
        remoteResult: REMOTE_FAILURE,
      }),
    ).toBeUndefined();
  });

  it("does not persist a success marker when both operations fail or abort", () => {
    expect(
      resolveHybridCompactionResults({
        model: MODEL,
        localResult: PORTABLE_FAILURE,
        remoteResult: REMOTE_FAILURE,
      }),
    ).toBeUndefined();
  });
});
