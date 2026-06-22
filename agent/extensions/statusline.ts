/**
 * Status line — ported from the user's Claude Code `ccstatusline` config.
 *
 * Rendered as a `belowEditor` widget so it sits directly below the editor.
 *
 * Single-line layout:
 *   model │ thinking │ ~/dir │ (branch)[gh-profile] │ ⇡#PR │ session   45%  90k/200k
 *
 * Pi data sources (vs ccstatusline widgets):
 *   - model           -> ctx.model.id
 *   - thinking-effort -> pi.getThinkingLevel()
 *   - directory       -> ctx.sessionManager.getCwd() (home-shortened)
 *   - session name    -> ctx.sessionManager.getSessionName()
 *   - git-branch      -> git rev-parse (cached; widgets get no footerData)
 *   - gh-profile      -> gh auth status --active (cached)
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
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Option, Schema } from "effect";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_COLOR: Record<ThinkingLevel, ThemeColor> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const LEFT_SEPARATOR = "│";

type GitState = { branch: string };
type GhState = { profile: string };
type LspClientState = { id: string; label: string };
type LspState = { running: ReadonlyArray<LspClientState>; broken: ReadonlyArray<LspClientState> };
type PrState = { number: number; url: string } | null;
type McpState = { text: string; compactText: string; color: ThemeColor } | null;

/** Shape of `gh pr view --json number,url` output. */
const PrInfo = Schema.Struct({ number: Schema.Number, url: Schema.String });
const PrInfoJson = Schema.fromJsonString(PrInfo);
const LspClientStateSchema = Schema.Struct({ id: Schema.String, label: Schema.String });
const LspStateSchema = Schema.Struct({
	running: Schema.Array(LspClientStateSchema),
	broken: Schema.Array(LspClientStateSchema),
});
const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeLspStateOption = Schema.decodeUnknownOption(LspStateSchema);
const decodePrInfoJson = Schema.decodeUnknownEffect(PrInfoJson);
const decodeErrorMessageOption = Schema.decodeUnknownOption(ErrorMessage);

/** Typed failure for any subprocess / decoding step in the data layer. */
class StatusLineError extends Schema.TaggedErrorClass<StatusLineError>()("StatusLineError", {
	reason: Schema.String,
}) {}

const statusLineError = (reason: string): StatusLineError => StatusLineError.make({ reason });

const unknownReason = (cause: unknown, fallback: string): string => {
	if (typeof cause === "string" && cause.length > 0) return cause;
	const decoded = decodeErrorMessageOption(cause);
	if (Option.isSome(decoded) && decoded.value.message.length > 0) return decoded.value.message;
	return fallback;
};

/** Wrap `pi.exec` as an Effect, surfacing spawn rejections as StatusLineError. */
const runExec = (pi: ExtensionAPI, cmd: string, args: ReadonlyArray<string>, timeoutMs: number) =>
	Effect.tryPromise({
		try: () => pi.exec(cmd, [...args], { timeout: timeoutMs }),
		catch: (cause) => statusLineError(`${cmd} exec failed: ${unknownReason(cause, "unknown")}`),
	});

/** Branch from git (non-zero exit → empty state). */
const fetchGit = Effect.fn("fetchGit")(function* (pi: ExtensionAPI) {
	const branchRes = yield* runExec(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], 3000);
	const branch = branchRes.code === 0 ? branchRes.stdout.trim().replace(/^HEAD$/, "") : "";
	return { branch } satisfies GitState;
});

/** Active GitHub CLI account/profile, or empty when `gh` is absent or unauthenticated. */
const fetchGhProfile = Effect.fn("fetchGhProfile")(function* (pi: ExtensionAPI) {
	const res = yield* runExec(
		pi,
		"gh",
		[
			"auth",
			"status",
			"--active",
			"--json",
			"hosts",
			"--jq",
			'.hosts | add | map(select(.active and .state == "success")) | .[0].login // ""',
		],
		5000,
	);
	const profile = res.code === 0 ? (res.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "") : "";
	return { profile } satisfies GhState;
});

/** The open PR for `branch` via `gh`, or null when there is none / gh is absent. */
const fetchPr = Effect.fn("fetchPr")(function* (pi: ExtensionAPI, branch: string) {
	if (!branch) return null;
	const res = yield* runExec(pi, "gh", ["pr", "view", branch, "--json", "number,url"], 5000);
	if (res.code !== 0) return null;
	return yield* decodePrInfoJson(res.stdout).pipe(
		Effect.mapError(() => statusLineError("gh json parse failed")),
	);
});

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

function lastPathSegment(path: string): string {
	const trimmed = path.replace(/\/+$/g, "");
	const index = trimmed.lastIndexOf("/");
	return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function compactPath(path: string): string {
	const shortened = shortenHome(path);
	if (shortened === "~") return shortened;

	const last = lastPathSegment(shortened);
	if (!last || shortened === last) return shortened;
	if (shortened.startsWith("~/")) return `~/${last}`;
	if (shortened.startsWith("/")) return `…/${last}`;
	return last;
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

const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
	`${ESCAPE_CHAR}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\))`,
	"g",
);

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function mcpStateFromFooter(footerData: ReadonlyFooterDataProvider | undefined): McpState {
	const raw = footerData?.getExtensionStatuses().get("mcp");
	const text = raw ? stripAnsi(raw).trim() : "";
	if (!text) return null;

	const counts = /^MCP:\s*(\d+)\/(\d+)\s+servers\b/.exec(text);
	if (counts) {
		const connected = Number(counts[1]);
		const total = Number(counts[2]);
		const color: ThemeColor = connected === total ? "success" : connected > 0 ? "warning" : "dim";
		return {
			text: `MCP: ${connected}/${total}`,
			compactText: `MCP ${connected}/${total}`,
			color,
		};
	}

	const connecting = text.toLowerCase().includes("connecting");
	return {
		text,
		compactText: connecting ? "MCP…" : "MCP",
		color: connecting ? "warning" : "accent",
	};
}

type LeftParts = {
	model: string;
	thinking: ThinkingLevel | "off" | undefined;
	dir: string;
	session: string | undefined;
	git: GitState;
	gh: GhState;
	pr: PrState;
	lsp: LspState;
	mcp: McpState;
};

type ResponsiveSegment = {
	readonly text: string;
	readonly compactText?: string;
	readonly priority: number;
	readonly required?: boolean;
};

function isLspState(value: unknown): value is LspState {
	return Option.isSome(decodeLspStateOption(value));
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

function joinResponsiveSegments(theme: Theme, segments: ReadonlyArray<ResponsiveSegment>): string {
	return segments.map((segment) => segment.text).join(theme.fg("dim", ` ${LEFT_SEPARATOR} `));
}

function chooseRemovalIndex(segments: ReadonlyArray<ResponsiveSegment>): number | undefined {
	let selectedIndex: number | undefined;
	let selectedPriority = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment || segment.required) continue;
		if (segment.priority >= selectedPriority) {
			selectedIndex = index;
			selectedPriority = segment.priority;
		}
	}

	return selectedIndex;
}

function buildLspSegment(theme: Theme, lsp: LspState): ResponsiveSegment {
	const running = lsp.running.map(shortLspName);
	const broken = lsp.broken.map(shortLspName);
	const color: ThemeColor = broken.length > 0 ? "warning" : running.length > 0 ? "success" : "dim";
	const label = running.length > 0 ? `LSP (${running.join(", ")})` : "LSP (Not running)";
	const brokenLabel = broken.length > 0 ? ` !(${broken.join(", ")})` : "";
	const compactLabel = broken.length > 0 ? "LSP!" : running.length > 0 ? "LSP✓" : "LSP–";

	return {
		text: theme.fg(color, `${label}${brokenLabel}`),
		compactText: theme.fg(color, compactLabel),
		priority: 40,
	};
}

function buildLeftSegments(theme: Theme, p: LeftParts): ReadonlyArray<ResponsiveSegment> {
	const segments: ResponsiveSegment[] = [
		{ text: theme.fg("accent", p.model), priority: 0, required: true },
	];

	if (p.thinking && p.thinking !== "off") {
		segments.push({ text: theme.fg(THINKING_COLOR[p.thinking], p.thinking), priority: 5 });
	}

	segments.push({
		text: theme.fg("dim", shortenHome(p.dir)),
		compactText: theme.fg("dim", compactPath(p.dir)),
		priority: 10,
	});

	if (p.git.branch) {
		const branch = theme.fg("dim", "(") + theme.fg("mdLink", p.git.branch) + theme.fg("dim", ")");
		const ghProfile = p.gh.profile
			? theme.fg("dim", "[") + theme.fg("accent", p.gh.profile) + theme.fg("dim", "]")
			: "";
		segments.push({
			text: branch + ghProfile,
			compactText: theme.fg("mdLink", p.git.branch),
			priority: 20,
		});
	}

	if (p.pr) {
		const label = theme.fg("mdLink", `⇡#${p.pr.number}`);
		segments.push({
			text: getCapabilities().hyperlinks ? hyperlink(label, p.pr.url) : label,
			priority: 30,
		});
	}

	segments.push(buildLspSegment(theme, p.lsp));

	if (p.mcp) {
		segments.push({
			text: theme.fg(p.mcp.color, p.mcp.text),
			compactText: theme.fg(p.mcp.color, p.mcp.compactText),
			priority: 50,
		});
	}

	if (p.session) {
		segments.push({ text: theme.fg("dim", p.session), priority: 60 });
	}

	return segments;
}

/** Build the left side, compacting/dropping optional segments to fit `availableWidth`. */
function buildLeft(theme: Theme, p: LeftParts, availableWidth: number): string {
	if (availableWidth <= 0) return "";

	const segments = buildLeftSegments(theme, p);
	const full = joinResponsiveSegments(theme, segments);
	if (visibleWidth(full) <= availableWidth) return full;

	const compactSegments = segments.map((segment) => ({
		...segment,
		text: segment.compactText ?? segment.text,
	}));
	const compact = joinResponsiveSegments(theme, compactSegments);
	if (visibleWidth(compact) <= availableWidth) return compact;

	const remaining = [...compactSegments];
	while (visibleWidth(joinResponsiveSegments(theme, remaining)) > availableWidth) {
		const removalIndex = chooseRemovalIndex(remaining);
		if (removalIndex === undefined) break;
		remaining.splice(removalIndex, 1);
	}

	const responsive = joinResponsiveSegments(theme, remaining);
	if (visibleWidth(responsive) <= availableWidth) return responsive;
	return truncateToWidth(responsive, availableWidth, theme.fg("dim", "…"));
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

/** Join left/right into a single padded line, preserving the right side when space is tight. */
function layout(theme: Theme, left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!left) return truncateToWidth(right, width, theme.fg("dim", "…"));

	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, theme.fg("dim", "…"));

	const gap = Math.max(1, width - visibleWidth(left) - rightWidth);
	return truncateToWidth(left + " ".repeat(gap) + right, width, "");
}

/** Assemble the full status line for the given render width. */
function renderLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	git: GitState,
	gh: GhState,
	pr: PrState,
	lsp: LspState,
	mcp: McpState,
	width: number,
): string[] {
	const usage = ctx.getContextUsage();
	const limit = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000;
	const right = buildRight(theme, usage?.tokens ?? null, limit, usage?.percent ?? null);
	const left = buildLeft(
		theme,
		{
			model: ctx.model ? prettyModel(ctx.model.id) : "no-model",
			thinking: pi.getThinkingLevel(),
			dir: ctx.sessionManager.getCwd(),
			session: ctx.sessionManager.getSessionName(),
			git,
			gh,
			pr,
			lsp,
			mcp,
		},
		Math.max(0, width - visibleWidth(right) - 1),
	);
	return [layout(theme, left, right, width)];
}

export default function (pi: ExtensionAPI) {
	// Cached git state, refreshed off the render path.
	let gitState: GitState = { branch: "" };
	let ghState: GhState = { profile: "" };
	let lspState: LspState = { running: [], broken: [] };
	let prState: PrState = null;
	let footerData: ReadonlyFooterDataProvider | undefined;
	// Branch the cached PR was looked up for — avoids showing a stale PR after a switch.
	let prBranch = "";
	let requestRender: (() => void) | undefined;

	// Refresh git state, then — only when the branch changed (gh is comparatively
	// slow) — the PR. A PR lookup failure degrades to "no PR" without discarding
	// git state; a git failure resets everything. requestRender always fires.
	const refresh = Effect.gen(function* () {
		const git = yield* fetchGit(pi);
		const gh = yield* fetchGhProfile(pi).pipe(
			Effect.catch(() => Effect.succeed<GhState>({ profile: "" })),
		);
		gitState = git;
		ghState = gh;
		if (git.branch !== prBranch) {
			prState = yield* fetchPr(pi, git.branch).pipe(
				Effect.catch(() => Effect.succeed<PrState>(null)),
			);
			prBranch = git.branch;
		}
	}).pipe(
		Effect.catchCause(() =>
			Effect.sync(() => {
				gitState = { branch: "" };
				ghState = { profile: "" };
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
						return renderLine(
							pi,
							ctx,
							theme,
							gitState,
							ghState,
							prState,
							lspState,
							mcpStateFromFooter(footerData),
							width,
						);
					},
				};
			},
			{ placement: "belowEditor" },
		);

		// Suppress the built-in footer so nothing renders below the status line, but keep a
		// handle to extension statuses (notably pi-mcp-adapter's `mcp` status).
		ctx.ui.setFooter((_tui, _theme, data) => {
			footerData = data;
			requestRender?.();
			return {
				dispose() {
					if (footerData === data) footerData = undefined;
				},
				invalidate() {
					requestRender?.();
				},
				render(): string[] {
					return [];
				},
			};
		});
	});

	pi.on("turn_end", runRefresh);
}
