import { Result } from "effect";
import { describe, expect, test } from "vitest";

import {
	resolveModelReference,
	type ModelRegistryForResolution,
	type ResolvableModelEntry,
} from "./model-resolver";

type TestModel = ResolvableModelEntry;

const MODELS = [
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
	{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
	{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
] as const satisfies ReadonlyArray<TestModel>;

const makeRegistry = (
	models: ReadonlyArray<TestModel> = MODELS,
	available?: ReadonlyArray<TestModel>,
): ModelRegistryForResolution<TestModel> => {
	const base = {
		find(provider: string, modelId: string): TestModel | undefined {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll(): ReadonlyArray<TestModel> {
			return models;
		},
	};
	return available ? { ...base, getAvailable: () => available } : base;
};

const expectModel = (
	input: string,
	registry: ModelRegistryForResolution<TestModel>,
	expected: TestModel,
): void => {
	const result = resolveModelReference(input, registry);
	expect(Result.isSuccess(result) ? result.success.model : result).toEqual(expected);
};

const expectReference = (
	input: string,
	registry: ModelRegistryForResolution<TestModel>,
	expected: string,
): void => {
	const result = resolveModelReference(input, registry);
	expect(Result.isSuccess(result) ? result.success.reference : result).toBe(expected);
};

describe("resolveModelReference", () => {
	test("resolves exact provider/modelId references", () => {
		expectReference("anthropic/claude-opus-4-6", makeRegistry(), "anthropic/claude-opus-4-6");
		expectReference("openai/gpt-4o", makeRegistry(), "openai/gpt-4o");
	});

	test("matches bare model ids case-insensitively", () => {
		expectModel("Claude-Opus-4-6", makeRegistry(), MODELS[0]);
		expectModel("gpt-4o", makeRegistry(), MODELS[3]);
	});

	test("matches useful substrings in ids and names", () => {
		expectModel("haiku", makeRegistry(), MODELS[2]);
		expectModel("sonnet", makeRegistry(), MODELS[1]);
		expectModel("Opus 4.6", makeRegistry(), MODELS[0]);
		expectModel("google pro", makeRegistry(), MODELS[4]);
	});

	test("treats dots and dashes as equivalent in version tokens", () => {
		const haiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		expectModel("claude-haiku-4.5", makeRegistry([haiku]), haiku);
		expectModel("anthropic/claude-haiku-4.5", makeRegistry([haiku]), haiku);
		expectModel("gemini-2-5-pro", makeRegistry(), MODELS[4]);
	});

	test("treats trailing date-stamp tokens as optional", () => {
		const dashHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
		const dotHaiku = { id: "claude-haiku-4.5", name: "Claude Haiku", provider: "anthropic" };
		const datedHaiku = {
			id: "claude-haiku-4-5-20251001",
			name: "Claude Haiku 4.5",
			provider: "anthropic",
		};

		expectModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([dashHaiku]), dashHaiku);
		expectModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([dotHaiku]), dotHaiku);
		expectModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([datedHaiku]), datedHaiku);
	});

	test("falls back to the same bare model id under another provider", () => {
		const gatewayHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "openrouter" };
		const anthropicHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };

		expectModel("anthropic/claude-haiku-4-5", makeRegistry([gatewayHaiku]), gatewayHaiku);
		expectModel(
			"anthropic/claude-haiku-4-5",
			makeRegistry([gatewayHaiku, anthropicHaiku]),
			anthropicHaiku,
		);
	});

	test("filters resolution to getAvailable when available", () => {
		const result = resolveModelReference("sonnet", makeRegistry(MODELS, [MODELS[0], MODELS[2]]));
		expect(Result.isFailure(result)).toBe(true);
		expectModel("haiku", makeRegistry(MODELS, [MODELS[2]]), MODELS[2]);
	});

	test("returns a typed error listing available models", () => {
		const result = resolveModelReference("nonexistent-model", makeRegistry());
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("ModelResolutionFailed");
			expect(result.failure.message).toContain('Model not found: "nonexistent-model"');
			expect(result.failure.message).toContain("Available models:");
			expect(result.failure.availableModels).toContain("anthropic/claude-opus-4-6");
			expect(result.failure.availableModels).toContain("openai/gpt-4o");
		}
	});

	test("prefers tighter matches among similar models", () => {
		const similarModels = [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
			{
				id: "claude-sonnet-4-5-20241022",
				name: "Claude Sonnet 4.5",
				provider: "anthropic",
			},
			{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
		] as const satisfies ReadonlyArray<TestModel>;

		expectModel("sonnet", makeRegistry(similarModels), similarModels[0]);
		expectModel("sonnet 4.5", makeRegistry(similarModels), similarModels[1]);
		expectModel("4-6", makeRegistry(similarModels), similarModels[0]);
	});
});
