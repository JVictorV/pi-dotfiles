// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
import { describe, expect, test } from "vitest";

import { prettyModelName } from "./model-name";

describe("prettyModelName", () => {
	test("title-cases model names and joins adjacent number parts", () => {
		expect(prettyModelName("claude-opus-4-8")).toBe("Claude Opus 4.8");
	});

	test("preserves known acronyms", () => {
		expect(prettyModelName("gpt-oss-120b")).toBe("GPT OSS 120b");
	});
});
