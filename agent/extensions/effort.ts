/**
 * Effort command extension.
 *
 * Registers `/effort` so the active reasoning/thinking effort can be changed
 * from a slash command instead of cycling with Shift+Tab.
 */

import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type EffortLevel = ModelThinkingLevel;

const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const EFFORT_ALIASES: Readonly<Record<string, EffortLevel>> = {
	0: "off",
	none: "off",
	no: "off",
	min: "minimal",
	extra: "xhigh",
	extrahigh: "xhigh",
	maximum: "max",
};

function parseEffortLevel(input: string): EffortLevel | undefined {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	if (!normalized) return undefined;

	for (const level of EFFORT_LEVELS) {
		if (normalized === level) return level;
	}

	return EFFORT_ALIASES[normalized];
}

function supportedEffortLevels(model: Model<Api> | undefined): ReadonlyArray<EffortLevel> {
	return model === undefined ? ["off"] : getSupportedThinkingLevels(model);
}

function completions(levels: ReadonlyArray<EffortLevel>): ReadonlyArray<AutocompleteItem> {
	return levels.map((level) => ({
		value: level,
		label: level === "xhigh" ? "xhigh (extra high)" : level,
	}));
}

function usage(levels: ReadonlyArray<EffortLevel>): string {
	return `Usage: /effort <${levels.join("|")}>`;
}

function notifyEffortChange(
	pi: ExtensionAPI,
	requested: EffortLevel,
	ctx: ExtensionCommandContext,
): void {
	const active = pi.getThinkingLevel();
	const clamped =
		active === requested ? "" : ` (requested ${requested}; clamped for current model)`;
	ctx.ui.notify(`Effort set to ${active}${clamped}`, "info");
}

async function chooseEffort(
	ctx: ExtensionCommandContext,
	levels: ReadonlyArray<EffortLevel>,
): Promise<EffortLevel | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(usage(levels), "info");
		return undefined;
	}

	const selected = await ctx.ui.select("Select effort level", [...levels]);
	if (selected === undefined) return undefined;
	return parseEffortLevel(selected);
}

/**
 * Register the `/effort` command.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	// ctx.model is a live getter; same-model metadata refreshes do not emit model_select.
	let activeContext: Pick<ExtensionContext, "model"> | undefined;
	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
	});

	pi.registerCommand("effort", {
		description: `Set reasoning effort (${EFFORT_LEVELS.join(", ")})`,
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.trim().toLowerCase();
			const matches = completions(supportedEffortLevels(activeContext?.model)).filter((item) =>
				item.value.startsWith(normalized),
			);
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			const levels = supportedEffortLevels(ctx.model);
			const requested = args.trim() ? parseEffortLevel(args) : await chooseEffort(ctx, levels);
			if (requested === undefined) {
				if (args.trim()) {
					ctx.ui.notify(`${usage(levels)} — unknown level: ${args.trim()}`, "warning");
				}
				return;
			}

			pi.setThinkingLevel(requested);
			notifyEffortChange(pi, requested, ctx);
		},
	});
}
