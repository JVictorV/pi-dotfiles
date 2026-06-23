import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";

/** Thinking levels pi can display in the status line. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Context usage facts rendered by the right-side status region. */
export type ContextUsageSnapshot = {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
};

/** Narrow render-time facts available to status-line segments. */
export type StatusLineRenderContext = {
	readonly theme: Theme;
	readonly width: number;
	readonly modelId: string | undefined;
	readonly thinking: ThinkingLevel | "off" | undefined;
	readonly cwd: string;
	readonly sessionName: string | undefined;
	readonly contextUsage: ContextUsageSnapshot;
	readonly terminal: { readonly hyperlinks: boolean };
};

/** Build the narrow render context from pi's extension APIs. */
export function makeStatusLineRenderContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	width: number,
): StatusLineRenderContext {
	const usage = ctx.getContextUsage();
	return {
		theme,
		width,
		modelId: ctx.model?.id,
		thinking: pi.getThinkingLevel(),
		cwd: ctx.sessionManager.getCwd(),
		sessionName: ctx.sessionManager.getSessionName(),
		contextUsage: {
			tokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000,
			percent: usage?.percent ?? null,
		},
		terminal: { hyperlinks: getCapabilities().hyperlinks },
	};
}
