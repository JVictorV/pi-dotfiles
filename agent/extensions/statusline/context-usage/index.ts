import type { StatusLineRenderContext } from "../core/render-context";

import { formatTokens, usageColor } from "./tokens";

/** Build the right-side context usage region. */
export function buildContextUsageRegion(context: StatusLineRenderContext): string {
	const { tokens, contextWindow, percent } = context.contextUsage;
	const raw =
		percent ?? (tokens !== null && contextWindow > 0 ? (tokens * 100) / contextWindow : 0);
	const pct = Math.min(100, raw);
	// Truncate (not round) to two decimals: xx.xx%.
	const pctStr = (Math.trunc(pct * 100) / 100).toFixed(2);
	const usedStr = tokens === null ? "?" : formatTokens(tokens);
	return (
		context.theme.fg(usageColor(pct), `${pctStr}%`) +
		context.theme.fg("dim", ` ${usedStr}/${formatTokens(contextWindow)}`)
	);
}
