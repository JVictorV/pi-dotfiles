/**
 * Status line — ported from the user's Claude Code `ccstatusline` config.
 *
 * Rendered as a `belowEditor` widget so it sits directly above the pi-lens
 * diagnostics bar (widgets render in registration order; registering at
 * session_start places this on top of pi-lens, which inserts its bar later).
 *
 * Single-line layout:
 *   model · thinking │ ~/dir (branch) +ins/-del • session      45%  90k/200k
 *
 * Pi data sources (vs ccstatusline widgets):
 *   - model           -> ctx.model.id
 *   - thinking-effort -> pi.getThinkingLevel()
 *   - directory       -> ctx.sessionManager.getCwd() (home-shortened)
 *   - session name    -> ctx.sessionManager.getSessionName()
 *   - git-branch      -> git rev-parse (cached; widgets get no footerData)
 *   - git-changes     -> git diff --numstat (cached)
 *   - context readout -> ctx.getContextUsage() (accurate tokens/window/percent)
 *
 * (voice-status from ccstatusline is omitted — it has no pi equivalent.)
 */

import { homedir } from "node:os";

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const THINKING_COLOR = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
} as const;

type GitState = { branch: string; added: number; removed: number };

/** Sum staged + unstaged line changes from `git diff --numstat` output. */
function parseNumstat(stdout: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of stdout.split("\n")) {
		const [a, d] = line.split("\t");
		if (a === undefined || d === undefined) continue;
		if (a !== "-") added += Number(a) || 0;
		if (d !== "-") removed += Number(d) || 0;
	}
	return { added, removed };
}

const ACRONYMS = new Set(["gpt", "ai", "llm", "vl", "oss"]);

/** Pretty-print a model id: "claude-opus-4-8" -> "Claude Opus 4.8". */
function prettyModel(id: string): string {
	const out: string[] = [];
	let nums: string[] = [];
	const flushNums = () => {
		if (nums.length) {
			out.push(nums.join("."));
			nums = [];
		}
	};
	for (const part of id.split("-")) {
		if (/^\d+(\.\d+)*$/.test(part)) {
			nums.push(part);
		} else {
			flushNums();
			out.push(
				ACRONYMS.has(part.toLowerCase())
					? part.toUpperCase()
					: part.charAt(0).toUpperCase() + part.slice(1),
			);
		}
	}
	flushNums();
	return out.join(" ");
}

/** Replace a leading home directory with "~". */
function shortenHome(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

function usageColor(pct: number): ThemeColor {
	if (pct >= 80) return "error";
	if (pct >= 50) return "warning";
	return "success";
}

type LeftParts = {
	model: string;
	thinking: keyof typeof THINKING_COLOR | "off" | undefined;
	dir: string;
	session: string | undefined;
	git: GitState;
};

/** Build the left side: model · thinking │ ~/dir (branch) +ins -del • session. */
function buildLeft(theme: Theme, p: LeftParts): string {
	const segs: string[] = [theme.fg("accent", p.model)];
	if (p.thinking && p.thinking !== "off") {
		segs.push(theme.fg("dim", "·"));
		segs.push(theme.fg(THINKING_COLOR[p.thinking], p.thinking));
	}
	segs.push(theme.fg("dim", "│"));
	segs.push(theme.fg("dim", shortenHome(p.dir)));
	if (p.git.branch) {
		segs.push(
			theme.fg("dim", "(") +
				theme.fg("mdLink", p.git.branch) +
				theme.fg("dim", ")"),
		);
	}
	if (p.git.added || p.git.removed) {
		const parts: string[] = [];
		if (p.git.added) parts.push(theme.fg("toolDiffAdded", `+${p.git.added}`));
		if (p.git.removed)
			parts.push(theme.fg("toolDiffRemoved", `-${p.git.removed}`));
		segs.push(parts.join(" "));
	}
	if (p.session) {
		segs.push(theme.fg("dim", `• ${p.session}`));
	}
	return segs.join(" ");
}

/** Build the right side: 45.67%  90k/200k ("?" when token count is unknown). */
function buildRight(
	theme: Theme,
	tokens: number | null,
	limit: number,
	percent: number | null,
): string {
	const raw =
		percent ?? (tokens !== null && limit > 0 ? (tokens * 100) / limit : 0);
	const pct = Math.min(100, raw);
	// Truncate (not round) to two decimals: xx.xx%.
	const pctStr = (Math.trunc(pct * 100) / 100).toFixed(2);
	const usedStr = tokens === null ? "?" : formatTokens(tokens);
	return (
		theme.fg(usageColor(pct), `${pctStr}%`) +
		theme.fg("dim", ` ${usedStr}/${formatTokens(limit)}`)
	);
}

/** Join left/right into a single padded line clamped to width with ellipsis. */
function layout(
	theme: Theme,
	left: string,
	right: string,
	width: number,
): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(
		left + " ".repeat(gap) + right,
		width,
		theme.fg("dim", "…"),
	);
}

/** Assemble the full status line for the given render width. */
function renderLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	git: GitState,
	width: number,
): string[] {
	const usage = ctx.getContextUsage();
	const limit = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000;
	const left = buildLeft(theme, {
		model: ctx.model ? prettyModel(ctx.model.id) : "no-model",
		thinking: pi.getThinkingLevel(),
		dir: ctx.sessionManager.getCwd(),
		session: ctx.sessionManager.getSessionName(),
		git,
	});
	const right = buildRight(
		theme,
		usage?.tokens ?? null,
		limit,
		usage?.percent ?? null,
	);
	return [layout(theme, left, right, width)];
}

export default function (pi: ExtensionAPI) {
	// Cached git state, refreshed off the render path.
	let gitState: GitState = { branch: "", added: 0, removed: 0 };
	let requestRender: (() => void) | undefined;

	async function refreshGit() {
		try {
			const [branchRes, diffRes] = await Promise.all([
				pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
					timeout: 3000,
				}),
				pi.exec("git", ["diff", "HEAD", "--numstat"], { timeout: 3000 }),
			]);
			const branch =
				branchRes.code === 0
					? branchRes.stdout.trim().replace(/^HEAD$/, "")
					: "";
			const changes =
				diffRes.code === 0
					? parseNumstat(diffRes.stdout)
					: { added: 0, removed: 0 };
			gitState = { branch, ...changes };
		} catch {
			gitState = { branch: "", added: 0, removed: 0 };
		}
		requestRender?.();
	}

	pi.on("session_start", (_event, ctx) => {
		void refreshGit();

		// belowEditor widget → renders directly above the pi-lens diagnostics bar.
		ctx.ui.setWidget(
			"statusline",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				const timer = setInterval(() => void refreshGit(), 5000);
				return {
					dispose() {
						clearInterval(timer);
						requestRender = undefined;
					},
					invalidate() {},
					render(width: number): string[] {
						return renderLine(pi, ctx, theme, gitState, width);
					},
				};
			},
			{ placement: "belowEditor" },
		);

		// Suppress the built-in footer so nothing renders below the status line.
		// (The pi-lens diagnostics bar is hidden separately via ~/.pi-lens/config.json.)
		ctx.ui.setFooter(() => ({
			invalidate() {},
			render(): string[] {
				return [];
			},
		}));
	});

	pi.on("turn_end", () => void refreshGit());
}
