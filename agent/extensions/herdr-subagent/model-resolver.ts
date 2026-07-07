import { Result } from "effect";

import { ModelResolutionFailed } from "./errors";

/** Minimal model entry shape required for herdr_subagent spawn model resolution. */
export interface ResolvableModelEntry {
	/** Provider slug used in canonical `provider/modelId` references. */
	readonly provider: string;
	/** Model id used by pi's `--model` flag after the provider prefix. */
	readonly id: string;
	/** Human-readable model display name. */
	readonly name: string;
}

/** Minimal pi model registry methods used for forgiving model resolution. */
export interface ModelRegistryForResolution<
	ModelEntry extends ResolvableModelEntry = ResolvableModelEntry,
> {
	/** Find a model by exact provider and model id. */
	find(provider: string, modelId: string): ModelEntry | undefined;
	/** Return every registered model, including models without configured auth. */
	getAll(): ReadonlyArray<ModelEntry>;
	/** Return models with configured auth when the registry can distinguish them. */
	getAvailable?(): ReadonlyArray<ModelEntry>;
}

/** A resolved canonical model reference suitable for `pi --model`. */
export interface ResolvedModelReference<
	ModelEntry extends ResolvableModelEntry = ResolvableModelEntry,
> {
	/** The exact registry entry selected by resolution. */
	readonly model: ModelEntry;
	/** Canonical `provider/modelId` string accepted by `pi --model`. */
	readonly reference: string;
}

const normalizeModelText = (input: string): string => input.toLowerCase().replace(/\./gu, "-");

const modelReference = (model: ResolvableModelEntry): string => `${model.provider}/${model.id}`;

const availableModels = <ModelEntry extends ResolvableModelEntry>(
	registry: ModelRegistryForResolution<ModelEntry>,
): ReadonlyArray<ModelEntry> => registry.getAvailable?.() ?? registry.getAll();

const availableModelReferences = (
	models: ReadonlyArray<ResolvableModelEntry>,
): ReadonlyArray<string> => models.map(modelReference).sort();

const notFound = (
	input: string,
	models: ReadonlyArray<ResolvableModelEntry>,
): ModelResolutionFailed => {
	const refs = availableModelReferences(models);
	const modelList = refs.map((ref) => `  ${ref}`).join("\n");
	return new ModelResolutionFailed({
		input,
		availableModels: refs,
		message: `Model not found: "${input}".\n\nAvailable models:\n${modelList}`,
	});
};

const found = <ModelEntry extends ResolvableModelEntry>(
	model: ModelEntry,
): ResolvedModelReference<ModelEntry> => ({
	model,
	reference: modelReference(model),
});

const splitProviderReference = (
	input: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
	const slashIndex = input.indexOf("/");
	if (slashIndex === -1) {
		return undefined;
	}
	return { provider: input.slice(0, slashIndex), modelId: input.slice(slashIndex + 1) };
};

const exactAvailableMatch = <ModelEntry extends ResolvableModelEntry>(
	input: string,
	registry: ModelRegistryForResolution<ModelEntry>,
	available: ReadonlyArray<ModelEntry>,
): ResolvedModelReference<ModelEntry> | undefined => {
	const parsed = splitProviderReference(input);
	if (!parsed) {
		return undefined;
	}
	const normalizedInput = input.toLowerCase();
	const availableSet = new Set(available.map((model) => modelReference(model).toLowerCase()));
	if (!availableSet.has(normalizedInput)) {
		return undefined;
	}
	const model = registry.find(parsed.provider, parsed.modelId);
	return model ? found(model) : undefined;
};

const scoreModel = (query: string, model: ResolvableModelEntry): number => {
	const id = normalizeModelText(model.id);
	const name = normalizeModelText(model.name);
	const provider = normalizeModelText(model.provider);
	const full = normalizeModelText(modelReference(model));

	if (id === query || full === query) {
		return 100;
	}
	if (id.includes(query) || full.includes(query)) {
		return 60 + (query.length / id.length) * 30;
	}
	if (name.includes(query)) {
		return 40 + (query.length / name.length) * 20;
	}

	const parts = query.split(/[\s\-/]+/u);
	if (
		parts.every(
			(part) =>
				/^\d{8}$/u.test(part) ||
				id.includes(part) ||
				name.includes(part) ||
				provider.includes(part),
		)
	) {
		return 20;
	}

	return 0;
};

const fuzzyMatch = <ModelEntry extends ResolvableModelEntry>(
	input: string,
	registry: ModelRegistryForResolution<ModelEntry>,
	available: ReadonlyArray<ModelEntry>,
): ResolvedModelReference<ModelEntry> | undefined => {
	const query = normalizeModelText(input);
	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const model of available) {
		const score = scoreModel(query, model);
		if (score > bestScore) {
			bestMatch = model;
			bestScore = score;
		}
	}

	if (bestMatch === undefined || bestScore < 20) {
		return undefined;
	}

	const exactModel = registry.find(bestMatch.provider, bestMatch.id);
	return found(exactModel ?? bestMatch);
};

/**
 * Resolve a user-provided model string into a canonical pi model reference.
 *
 * Resolution is deliberately forgiving for stale subagent prompts and model pins:
 * exact `provider/modelId` references win, then case-insensitive fuzzy matching
 * treats dots and dashes in version numbers as equivalent, ignores trailing
 * `-YYYYMMDD` date-stamp tokens when necessary, scores substring matches, and
 * finally retries a failed `provider/modelId` query as a bare model id under any
 * provider.
 *
 * @param input - User-provided model string from tool params or agent frontmatter.
 * @param registry - pi model registry used as the source of available models.
 * @returns The canonical model reference, or a typed error listing available models.
 */
export function resolveModelReference<ModelEntry extends ResolvableModelEntry>(
	input: string,
	registry: ModelRegistryForResolution<ModelEntry>,
): Result.Result<ResolvedModelReference<ModelEntry>, ModelResolutionFailed> {
	const available = availableModels(registry);
	const exact = exactAvailableMatch(input, registry, available);
	if (exact) {
		return Result.succeed(exact);
	}

	const fuzzy = fuzzyMatch(input, registry, available);
	if (fuzzy) {
		return Result.succeed(fuzzy);
	}

	const parsed = splitProviderReference(input);
	if (parsed) {
		const bare = fuzzyMatch(parsed.modelId, registry, available);
		if (bare) {
			return Result.succeed(bare);
		}
	}

	return Result.fail(notFound(input, available));
}
