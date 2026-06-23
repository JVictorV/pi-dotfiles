import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Format a token count for compact display. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

/** Choose the status color for a context usage percentage. */
export function usageColor(pct: number): ThemeColor {
	if (pct >= 80) return "error";
	if (pct >= 50) return "warning";
	return "success";
}
