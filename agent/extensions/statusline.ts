/**
 * Status line — ported from the user's Claude Code `ccstatusline` config.
 *
 * Rendered as a `belowEditor` widget so it sits directly below the editor.
 *
 * Single-line layout:
 *   model · thinking │ ~/dir (branch) ⇡#PR +ins/-del • session   45%  90k/200k
 *
 * Pi data sources (vs ccstatusline widgets):
 *   - model           -> ctx.model.id
 *   - thinking-effort -> pi.getThinkingLevel()
 *   - directory       -> ctx.sessionManager.getCwd() (home-shortened)
 *   - session name    -> ctx.sessionManager.getSessionName()
 *   - git-branch      -> git rev-parse (cached; widgets get no footerData)
 *   - git-changes     -> git diff --numstat (cached)
 *   - pr-link         -> gh pr view <branch> (cached; OSC 8 clickable link)
 *
 * The data layer (git + gh subprocesses, JSON decoding, state refresh) runs as
 * Effect programs on detached fibers (`Effect.runFork`) so it never blocks the
 * render path; failures are caught and reset state for the next tick.
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
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Schema } from "effect";

const THINKING_COLOR = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
} as const;

type GitState = { branch: string; added: number; removed: number };
type LspClientState = { id: string; label: string };
type LspState = { running: ReadonlyArray<LspClientState>; broken: ReadonlyArray<LspClientState> };
type PrState = { number: number; url: string } | null;

/** Shape of `gh pr view --json number,url` output. */
const PrInfo = Schema.Struct({ number: Schema.Number, url: Schema.String });

/** Typed failure for any subprocess / decoding step in the data layer. */
class StatusLineError extends Schema.TaggedErrorClass<StatusLineError>()("StatusLineError", {
	reason: Schema.String,
}) {}

const statusLineError = (reason: string): StatusLineError => StatusLineError.make({ reason });

/** Wrap `pi.exec` as an Effect, surfacing spawn rejections as StatusLineError. */
const runExec = (pi: ExtensionAPI, cmd: string, args: ReadonlyArray<string>, timeoutMs: number) =>
	Effect.tryPromise({
		try: () => pi.exec(cmd, [...args], { timeout: timeoutMs }),
		catch: (cause) => statusLineError(`${cmd} exec failed: ${String(cause)}`),
	});

/** Branch + staged/unstaged line changes from git (non-zero exit → empty state). */
const fetchGit = Effect.fn("fetchGit")(function* (pi: ExtensionAPI) {
	const [branchRes, diffRes] = yield* Effect.all(
		[
			runExec(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], 3000),
			runExec(pi, "git", ["diff", "HEAD", "--numstat"], 3000),
		],
		{ concurrency: "unbounded" },
	);
	const branch = branchRes.code === 0 ? branchRes.stdout.trim().replace(/^HEAD$/, "") : "";
	const changes = diffRes.code === 0 ? parseNumstat(diffRes.stdout) : { added: 0, removed: 0 };
	return { branch, ...changes } satisfies GitState;
});

/** The open PR for `branch` via `gh`, or null when there is none / gh is absent. */
const fetchPr = Effect.fn("fetchPr")(function* (pi: ExtensionAPI, branch: string) {
	if (!branch) return null;
	const res = yield* runExec(pi, "gh", ["pr", "view", branch, "--json", "number,url"], 5000);
	if (res.code !== 0) return null;
	const json = yield* Effect.try({
		try: () => JSON.parse(res.stdout) as unknown,
		catch: (cause) => statusLineError(`gh json parse failed: ${String(cause)}`),
	});
	return yield* Schema.decodeUnknownEffect(PrInfo)(json);
});

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
	pr: PrState;
	lsp: LspState;
};

function isLspClientState(value: unknown): value is LspClientState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.label === "string";
}

function isLspState(value: unknown): value is LspState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Array.isArray(record.running) &&
		record.running.every(isLspClientState) &&
		Array.isArray(record.broken) &&
		record.broken.every(isLspClientState)
	);
}

function shortLspName(client: LspClientState): string {
	switch (client.id) {
		case "typescript":
			return "TS";
		case "rust-analyzer":
			return "Rust";
		case "pyright":
			return "Python";
		case "gopls":
			return "Go";
		case "bash-language-server":
			return "Shell";
		case "json":
			return "JSON";
		case "css":
			return "CSS";
		case "html":
			return "HTML";
		case "eslint":
			return "ESLint";
		case "yaml":
			return "YAML";
		default:
			return client.label || client.id;
	}
}

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
		segs.push(theme.fg("dim", "(") + theme.fg("mdLink", p.git.branch) + theme.fg("dim", ")"));
	}
	if (p.pr) {
		const label = theme.fg("mdLink", `⇡#${p.pr.number}`);
		segs.push(getCapabilities().hyperlinks ? hyperlink(label, p.pr.url) : label);
	}
	if (p.git.added || p.git.removed) {
		const parts: string[] = [];
		if (p.git.added) parts.push(theme.fg("toolDiffAdded", `+${p.git.added}`));
		if (p.git.removed) parts.push(theme.fg("toolDiffRemoved", `-${p.git.removed}`));
		segs.push(parts.join(" "));
	}
	{
		const running = p.lsp.running.map(shortLspName);
		const broken = p.lsp.broken.map(shortLspName);
		const color: ThemeColor =
			broken.length > 0 ? "warning" : running.length > 0 ? "success" : "dim";
		const label = running.length > 0 ? `LSP (${running.join(", ")})` : "LSP (Not running)";
		const brokenLabel = broken.length > 0 ? ` !(${broken.join(", ")})` : "";
		segs.push(theme.fg(color, `${label}${brokenLabel}`));
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
	const raw = percent ?? (tokens !== null && limit > 0 ? (tokens * 100) / limit : 0);
	const pct = Math.min(100, raw);
	// Truncate (not round) to two decimals: xx.xx%.
	const pctStr = (Math.trunc(pct * 100) / 100).toFixed(2);
	const usedStr = tokens === null ? "?" : formatTokens(tokens);
	return (
		theme.fg(usageColor(pct), `${pctStr}%`) + theme.fg("dim", ` ${usedStr}/${formatTokens(limit)}`)
	);
}

/** Join left/right into a single padded line clamped to width with ellipsis. */
function layout(theme: Theme, left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, width, theme.fg("dim", "…"));
}

/** Assemble the full status line for the given render width. */
function renderLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	git: GitState,
	pr: PrState,
	lsp: LspState,
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
		pr,
		lsp,
	});
	const right = buildRight(theme, usage?.tokens ?? null, limit, usage?.percent ?? null);
	return [layout(theme, left, right, width)];
}

export default function (pi: ExtensionAPI) {
	// Cached git state, refreshed off the render path.
	let gitState: GitState = { branch: "", added: 0, removed: 0 };
	let lspState: LspState = { running: [], broken: [] };
	let prState: PrState = null;
	// Branch the cached PR was looked up for — avoids showing a stale PR after a switch.
	let prBranch = "";
	let requestRender: (() => void) | undefined;

	// Refresh git state, then — only when the branch changed (gh is comparatively
	// slow) — the PR. A PR lookup failure degrades to "no PR" without discarding
	// git state; a git failure resets everything. requestRender always fires.
	const refresh = Effect.gen(function* () {
		const git = yield* fetchGit(pi);
		gitState = git;
		if (git.branch !== prBranch) {
			prState = yield* fetchPr(pi, git.branch).pipe(
				Effect.catch(() => Effect.succeed<PrState>(null)),
			);
			prBranch = git.branch;
		}
	}).pipe(
		Effect.catchCause(() =>
			Effect.sync(() => {
				gitState = { branch: "", added: 0, removed: 0 };
				prState = null;
				prBranch = "";
			}),
		),
		Effect.ensuring(Effect.sync(() => requestRender?.())),
	);

	const runRefresh = (): void => {
		Effect.runFork(refresh);
	};

	pi.events.on("lsp:status", (data) => {
		if (!isLspState(data)) return;
		lspState = data;
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		runRefresh();

		// belowEditor widget → renders directly below the editor.
		ctx.ui.setWidget(
			"statusline",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				const timer = setInterval(runRefresh, 5000);
				return {
					dispose() {
						clearInterval(timer);
						requestRender = undefined;
					},
					invalidate() {},
					render(width: number): string[] {
						return renderLine(pi, ctx, theme, gitState, prState, lspState, width);
					},
				};
			},
			{ placement: "belowEditor" },
		);

		// Suppress the built-in footer so nothing renders below the status line.
		ctx.ui.setFooter(() => ({
			invalidate() {},
			render(): string[] {
				return [];
			},
		}));
	});

	pi.on("turn_end", runRefresh);
}
