import { describe, expect, it } from "vitest";
import openaiServerCompactionExtension from "./index.ts";

describe("vendored OpenAI server compaction extension", () => {
	it("loads its auto-discovered entrypoint", () => {
		expect(openaiServerCompactionExtension).toBeTypeOf("function");
	});
});
