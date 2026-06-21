/**
 * Effort command extension.
 *
 * Registers `/effort` so the active reasoning/thinking effort can be changed
 * from a slash command instead of cycling with Shift+Tab.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

const EFFORT_ALIASES: Readonly<Record<string, EffortLevel>> = {
	0: "off",
	none: "off",
	no: "off",
	min: "minimal",
	extra: "xhigh",
	extrahigh: "xhigh",
	max: "xhigh",
	maximum: "xhigh",
};

const EFFORT_COMPLETIONS: ReadonlyArray<AutocompleteItem> = EFFORT_LEVELS.map((level) => ({
	value: level,
	label: level === "xhigh" ? "xhigh (extra high)" : level,
}));

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

function usage(): string {
	return `Usage: /effort <${EFFORT_LEVELS.join("|")}>`;
}

function notifyEffortChange(
	pi: ExtensionAPI,
	requested: EffortLevel,
	ctx: ExtensionCommandContext,
): void {
	const active = pi.getThinkingLevel();
	const clamped = active === requested ? "" : ` (clamped to ${active} for current model)`;
	ctx.ui.notify(`Effort set to ${active}${clamped}`, "info");
}

async function chooseEffort(ctx: ExtensionCommandContext): Promise<EffortLevel | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(usage(), "info");
		return undefined;
	}

	const selected = await ctx.ui.select("Select effort level", [...EFFORT_LEVELS]);
	if (selected === undefined) return undefined;
	return parseEffortLevel(selected);
}

/**
 * Register the `/effort` command.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: `Set reasoning effort (${EFFORT_LEVELS.join(", ")})`,
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.trim().toLowerCase();
			const matches = EFFORT_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim() ? parseEffortLevel(args) : await chooseEffort(ctx);
			if (requested === undefined) {
				if (args.trim()) ctx.ui.notify(`${usage()} — unknown level: ${args.trim()}`, "warning");
				return;
			}

			pi.setThinkingLevel(requested);
			notifyEffortChange(pi, requested, ctx);
		},
	});
}
