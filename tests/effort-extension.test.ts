import {
	clampThinkingLevel,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assert, describe, it } from "vitest";

import effortExtension from "../agent/extensions/effort";

type EffortCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type Notification = {
	readonly message: string;
	readonly level: "info" | "warning" | "error" | undefined;
};

const model = (id: string, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]): Model<Api> => ({
	id,
	name: id,
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinkingLevelMap,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

const createHarness = () => {
	let command: EffortCommand | undefined;
	let currentLevel: ModelThinkingLevel = "off";
	let currentModel: Model<Api> | undefined;
	let sessionStart: ((model: Model<Api> | undefined) => void) | undefined;
	let modelSelect: ((model: Model<Api>) => void) | undefined;
	let selected: string | undefined;
	const requestedLevels: ModelThinkingLevel[] = [];
	const notifications: Notification[] = [];
	const pickerOptions: string[][] = [];

	const context = (hasUI = true) => {
		const value = {
			get model() {
				return currentModel;
			},
			hasUI,
			ui: {
				notify(message: string, level?: Notification["level"]) {
					notifications.push({ message, level });
				},
				async select(_title: string, options: string[]) {
					pickerOptions.push(options);
					return selected;
				},
			},
		};
		// SAFETY: The captured command only reads model, hasUI, ui.notify, and ui.select from this test seam.
		return value as unknown as ExtensionCommandContext;
	};

	const fakePi = {
		on(event: string, handler: unknown) {
			if (typeof handler !== "function") return;
			if (event === "session_start") {
				sessionStart = () => handler({ type: "session_start" }, context());
			}
			if (event === "model_select") {
				modelSelect = (activeModel) =>
					handler({ type: "model_select", model: activeModel }, context());
			}
		},
		registerCommand(name: string, options: EffortCommand) {
			if (name === "effort") command = options;
		},
		getThinkingLevel() {
			return currentLevel;
		},
		setThinkingLevel(level: ModelThinkingLevel) {
			requestedLevels.push(level);
			currentLevel = currentModel === undefined ? "off" : clampThinkingLevel(currentModel, level);
		},
	};
	// SAFETY: The extension only uses the methods implemented by this captured command seam.
	effortExtension(fakePi as unknown as ExtensionAPI);

	const registeredCommand = (): EffortCommand => {
		if (command === undefined) throw new Error("The effort command was not registered");
		return command;
	};

	return {
		command: registeredCommand,
		context,
		notifications,
		pickerOptions,
		requestedLevels,
		setPickerSelection(value: string | undefined) {
			selected = value;
		},
		start(activeModel: Model<Api> | undefined) {
			currentModel = activeModel;
			sessionStart?.(activeModel);
		},
		selectModel(activeModel: Model<Api>) {
			currentModel = activeModel;
			modelSelect?.(activeModel);
		},
		refreshModel(activeModel: Model<Api>) {
			currentModel = activeModel;
		},
	};
};

const completionValues = (command: EffortCommand, prefix = ""): string[] => {
	const result = command.getArgumentCompletions?.(prefix);
	if (result instanceof Promise) throw new Error("Effort completions must be synchronous");
	return result?.map((item) => item.value) ?? [];
};

describe("/effort", () => {
	it("uses the active model levels for completion and the picker, including model changes", async () => {
		const harness = createHarness();
		const maxModel = model("max-model", {
			off: null,
			minimal: null,
			medium: null,
			xhigh: null,
			max: "max",
		});
		harness.start(maxModel);

		assert.deepEqual(completionValues(harness.command()), ["low", "high", "max"]);
		harness.setPickerSelection("max");
		await harness.command().handler("", harness.context());
		assert.deepEqual(harness.pickerOptions, [["low", "high", "max"]]);
		assert.deepEqual(harness.requestedLevels, ["max"]);
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Effort set to max",
			level: "info",
		});

		const standardModel = model("standard-model");
		harness.selectModel(standardModel);
		assert.deepEqual(completionValues(harness.command()), [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("refreshes completions when current model metadata changes without a model-select event", () => {
		const harness = createHarness();
		harness.start(model("same-model"));
		assert.deepEqual(completionValues(harness.command(), "m"), ["minimal", "medium"]);

		harness.refreshModel(model("same-model", { off: null, minimal: null, max: "max" }));

		assert.deepEqual(completionValues(harness.command()), ["low", "medium", "high", "max"]);
	});

	it("shows model-aware usage when no model is active", async () => {
		const harness = createHarness();
		harness.start(undefined);

		assert.deepEqual(completionValues(harness.command()), ["off"]);
		await harness.command().handler("", harness.context(false));
		assert.deepEqual(harness.notifications, [{ message: "Usage: /effort <off>", level: "info" }]);
	});

	it("preserves maximum as max and reports model clamping honestly", async () => {
		const harness = createHarness();
		const standardModel = model("standard-model");
		harness.start(standardModel);

		await harness.command().handler("maximum", harness.context());

		assert.deepEqual(harness.requestedLevels, ["max"]);
		assert.deepEqual(harness.notifications, [
			{
				message: "Effort set to high (requested max; clamped for current model)",
				level: "info",
			},
		]);
	});

	it("preserves the existing concise aliases", async () => {
		const harness = createHarness();
		const extendedModel = model("extended-model", { xhigh: "xhigh", max: "max" });
		harness.start(extendedModel);

		await harness.command().handler("none", harness.context());
		await harness.command().handler("min", harness.context());
		await harness.command().handler("extra-high", harness.context());

		assert.deepEqual(harness.requestedLevels, ["off", "minimal", "xhigh"]);
	});

	it("lists only active model levels in unknown-level usage", async () => {
		const harness = createHarness();
		const highOnlyModel = model("high-only", {
			minimal: null,
			low: null,
			medium: null,
			xhigh: null,
			max: null,
		});
		harness.start(highOnlyModel);

		await harness.command().handler("turbo", harness.context());

		assert.deepEqual(harness.notifications, [
			{
				message: "Usage: /effort <off|high> — unknown level: turbo",
				level: "warning",
			},
		]);
	});
});
