/**
 * Auto-compaction at an absolute context threshold.
 *
 * Pi's built-in auto-compaction only fires when the context approaches the
 * model's window (`contextWindow - reserveTokens`), which is ~384K on GPT-5.6.
 * Cache-read billing makes large contexts expensive long before that: every
 * turn re-bills the whole accumulated context. This extension compacts as soon
 * as the estimated context crosses an absolute token threshold, independent of
 * the model's window size, so marathon sessions stop ballooning past ~120K.
 *
 * Commands:
 * - `/auto-compact` — show current threshold and context usage.
 * - `/auto-compact <tokens>` — set the threshold (accepts `120000` or `120k`).
 * - `/auto-compact off` / `/auto-compact on` — disable/enable for this session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Default absolute context-token threshold that triggers compaction. */
const DEFAULT_THRESHOLD_TOKENS = 120_000;

/**
 * Lower bound for configurable thresholds. Compaction keeps ~20K recent tokens
 * plus a summary, so thresholds below this risk a compact-every-turn loop.
 */
const MIN_THRESHOLD_TOKENS = 40_000;

type AutoCompactState = {
	/** Absolute token threshold, or "off" when disabled for this session. */
	threshold: number | "off";
	/** True while a compaction triggered by this extension is in flight. */
	inFlight: boolean;
	/**
	 * Context size at the last failed attempt. Prevents hammering a failing
	 * compaction every turn; we only retry once the context has grown further.
	 */
	failedAtTokens: number | null;
};

/**
 * Parse a threshold argument such as `120000`, `120_000`, or `120k`.
 *
 * @param input - Raw command argument.
 * @returns The threshold in tokens, or undefined when unparseable.
 */
function parseThreshold(input: string): number | undefined {
	const normalized = input.trim().toLowerCase().replace(/_/g, "");
	const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(normalized);
	if (!match || match[1] === undefined) return undefined;

	const magnitude = Number(match[1]);
	if (!Number.isFinite(magnitude)) return undefined;

	return Math.round(match[2] === "k" ? magnitude * 1_000 : magnitude);
}

/** Format a token count as a compact human-readable string, e.g. `120K`. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}

/**
 * Register threshold-based auto-compaction and the `/auto-compact` command.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	const state: AutoCompactState = {
		threshold: DEFAULT_THRESHOLD_TOKENS,
		inFlight: false,
		failedAtTokens: null,
	};

	const notify = (ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, kind);
	};

	const triggerCompaction = (ctx: ExtensionContext, tokens: number, threshold: number) => {
		state.inFlight = true;
		notify(
			ctx,
			`Auto-compacting: context ${formatTokens(tokens)} > ${formatTokens(threshold)}`,
			"info",
		);
		ctx.compact({
			onComplete: (result) => {
				state.inFlight = false;
				state.failedAtTokens = null;
				const after =
					result.estimatedTokensAfter === undefined
						? ""
						: ` → ~${formatTokens(result.estimatedTokensAfter)}`;
				notify(ctx, `Auto-compaction done: ${formatTokens(result.tokensBefore)}${after}`, "info");
			},
			onError: (error) => {
				state.inFlight = false;
				state.failedAtTokens = tokens;
				notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
			},
		});
	};

	pi.on("turn_end", (_event, ctx) => {
		if (state.threshold === "off" || state.inFlight) return;

		const tokens = ctx.getContextUsage()?.tokens ?? null;
		if (tokens === null) return;

		if (tokens <= state.threshold) {
			state.failedAtTokens = null;
			return;
		}

		// After a failure, wait for the context to grow before retrying so a
		// persistently failing compaction does not fire on every turn.
		if (state.failedAtTokens !== null && tokens <= state.failedAtTokens) return;

		triggerCompaction(ctx, tokens, state.threshold);
	});

	pi.registerCommand("auto-compact", {
		description: `Threshold auto-compaction (default ${formatTokens(DEFAULT_THRESHOLD_TOKENS)}): /auto-compact [tokens|on|off]`,
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();

			if (argument === "off") {
				state.threshold = "off";
				notify(ctx, "Auto-compaction disabled for this session", "info");
				return;
			}

			if (argument === "on") {
				if (state.threshold === "off") state.threshold = DEFAULT_THRESHOLD_TOKENS;
				notify(ctx, `Auto-compaction on at ${formatTokens(state.threshold)} tokens`, "info");
				return;
			}

			if (argument !== "") {
				const threshold = parseThreshold(argument);
				if (threshold === undefined) {
					notify(
						ctx,
						`Cannot parse "${args.trim()}" — usage: /auto-compact [tokens|on|off]`,
						"warning",
					);
					return;
				}
				if (threshold < MIN_THRESHOLD_TOKENS) {
					notify(
						ctx,
						`Threshold ${formatTokens(threshold)} is below the ${formatTokens(MIN_THRESHOLD_TOKENS)} minimum (risks a compaction loop)`,
						"warning",
					);
					return;
				}
				state.threshold = threshold;
				state.failedAtTokens = null;
				notify(ctx, `Auto-compaction threshold set to ${formatTokens(threshold)} tokens`, "info");
				return;
			}

			const usage = ctx.getContextUsage();
			const current = usage?.tokens == null ? "unknown" : formatTokens(usage.tokens);
			const status =
				state.threshold === "off" ? "off" : `on at ${formatTokens(state.threshold)} tokens`;
			notify(ctx, `Auto-compaction ${status} — current context: ${current}`, "info");
		},
	});
}
