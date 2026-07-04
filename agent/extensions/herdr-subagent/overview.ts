import type { HerdrAgent } from "./schemas";
import { matchEntriesToAgents } from "./store";
import type { RegistryEntry } from "./types";

/** Status category rendered in the ambient herdr subagent overview widget. */
export type OverviewRowKind =
	| "working"
	| "blocked"
	| "idle"
	| "done"
	| "unknown"
	| "missing"
	| "spawning";

/** One rendered subagent row before text formatting. */
export interface OverviewRow {
	readonly name: string;
	readonly kind: OverviewRowKind;
	readonly elapsedMs?: number;
}

/** Overview model consumed by the widget renderer. */
export interface Overview {
	readonly rows: ReadonlyArray<OverviewRow>;
	readonly counts: Readonly<Record<OverviewRowKind, number>>;
	/** Wall-clock time the snapshot was taken; lets renderers age elapsed times. */
	readonly atMs: number;
}

/** Rendering options for {@link renderOverview}. */
export interface RenderOverviewOptions {
	/**
	 * Wall-clock time of the render. Elapsed times are aged by the difference
	 * from the snapshot's `atMs`, so a stale snapshot still shows a live clock.
	 * Defaults to the snapshot time (no aging).
	 */
	readonly nowMs?: number;
	/** Maximum number of subagent rows to show before truncating. Default 6. */
	readonly maxRows?: number;
}

/**
 * Theme roles the overview renderer paints with.
 *
 * A subset of pi's full `ThemeColor` palette, kept narrow so the renderer only
 * depends on the roles it actually uses and tests can pass a tagging fake.
 */
export type OverviewThemeRole =
	| "text"
	| "accent"
	| "muted"
	| "dim"
	| "success"
	| "error"
	| "warning";

/**
 * Minimal theme surface the overview renderer needs.
 *
 * pi's `Theme` satisfies this structurally, so the widget can pass the live
 * theme directly while tests pass a fake that tags text with its color role.
 */
export interface OverviewTheme {
	/** Paint `text` with the foreground color for `role`. */
	fg(role: OverviewThemeRole, text: string): string;
	/** Render `text` bold. */
	bold(text: string): string;
}

/** Visual treatment for a row kind: glyph, color roles, and whether it demands attention. */
interface KindStyle {
	readonly glyph: string;
	/** Color role for the glyph (and the header count chip). */
	readonly glyphRole: OverviewThemeRole;
	/** Color role for the subagent name; may de-emphasize relative to the glyph. */
	readonly nameRole: OverviewThemeRole;
	/** Whether the glyph and name are bolded to pull the eye. */
	readonly bold: boolean;
}

const KIND_STYLES: Readonly<Record<OverviewRowKind, KindStyle>> = {
	blocked: { glyph: "⚠", glyphRole: "warning", nameRole: "warning", bold: true },
	// The name stays in plain text: the accent glyph alone carries the state, so
	// rows keep contrast between marker and label instead of washing into one hue.
	working: { glyph: "●", glyphRole: "accent", nameRole: "text", bold: false },
	spawning: { glyph: "◌", glyphRole: "dim", nameRole: "dim", bold: false },
	done: { glyph: "✓", glyphRole: "success", nameRole: "muted", bold: false },
	idle: { glyph: "○", glyphRole: "muted", nameRole: "muted", bold: false },
	unknown: { glyph: "?", glyphRole: "dim", nameRole: "dim", bold: false },
	missing: { glyph: "✗", glyphRole: "error", nameRole: "error", bold: false },
};

const OVERVIEW_KIND_ORDER: ReadonlyArray<OverviewRowKind> = [
	"blocked",
	"working",
	"spawning",
	"done",
	"idle",
	"unknown",
	"missing",
];

const ROW_SORT_ORDER: ReadonlyArray<OverviewRowKind> = OVERVIEW_KIND_ORDER;

const NAME_MAX_WIDTH = 22;

const emptyCounts = (): Record<OverviewRowKind, number> => ({
	working: 0,
	blocked: 0,
	idle: 0,
	done: 0,
	unknown: 0,
	missing: 0,
	spawning: 0,
});

const isOverviewRowKind = (value: string): value is OverviewRowKind =>
	value === "working" ||
	value === "blocked" ||
	value === "idle" ||
	value === "done" ||
	value === "unknown";

const kindForAgent = (agent: HerdrAgent): OverviewRowKind => {
	const status = agent.agent_status;
	if (!status) {
		return "unknown";
	}
	return isOverviewRowKind(status) ? status : "unknown";
};

const elapsedSinceCreated = (entry: RegistryEntry, nowMs: number): number | undefined => {
	const createdAt = Date.parse(entry.createdAt);
	if (!Number.isFinite(createdAt)) {
		return undefined;
	}
	return Math.max(0, nowMs - createdAt);
};

const sortRank = (kind: OverviewRowKind): number => ROW_SORT_ORDER.indexOf(kind);

const formatElapsed = (elapsedMs: number | undefined): string => {
	if (elapsedMs === undefined) {
		return "-";
	}
	const totalSeconds = Math.floor(elapsedMs / 1_000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m${String(seconds).padStart(2, "0")}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h${String(minutes).padStart(2, "0")}m`;
};

const truncateName = (name: string): string =>
	name.length > NAME_MAX_WIDTH ? `${name.slice(0, NAME_MAX_WIDTH - 1)}…` : name;

const paint = (
	theme: OverviewTheme,
	role: OverviewThemeRole,
	bold: boolean,
	text: string,
): string => theme.fg(role, bold ? theme.bold(text) : text);

/**
 * Build the pure overview model for registry-owned subagents.
 *
 * @param entries - Registry entries owned by the herdr_subagent tool.
 * @param agents - Live herdr agents reported by `herdr agent list`.
 * @param nowMs - Current wall-clock time in milliseconds.
 * @returns Rows for registry entries only, with aggregate counts by row kind.
 */
export const buildOverview = (
	entries: ReadonlyArray<RegistryEntry>,
	agents: ReadonlyArray<HerdrAgent>,
	nowMs: number,
): Overview => {
	const rows: OverviewRow[] = [];
	const counts = emptyCounts();

	for (const match of matchEntriesToAgents(entries, agents)) {
		const entry = match.entry;
		if (!entry) {
			continue;
		}
		const kind: OverviewRowKind =
			entry.phase === "reserved" ? "spawning" : match.agent ? kindForAgent(match.agent) : "missing";
		counts[kind] += 1;
		rows.push({
			name: entry.name,
			kind,
			elapsedMs: elapsedSinceCreated(entry, nowMs),
		});
	}

	return { rows, counts, atMs: nowMs };
};

/**
 * Render an overview model as themed widget lines.
 *
 * Colors are computed from `theme` on every call rather than pre-baked, so
 * theme switches take effect when the widget re-renders. The layout leans on
 * colored glyphs to carry state at a glance; only `blocked` is also spelled
 * out because it demands action.
 *
 * @param overview - Overview model returned by {@link buildOverview}.
 * @param theme - Theme surface used to color glyphs, names, counts, and metadata.
 * @param options - Render-time clock and row truncation overrides.
 * @returns Themed widget lines, or an empty array when there are no rows.
 */
export const renderOverview = (
	overview: Overview,
	theme: OverviewTheme,
	options?: RenderOverviewOptions,
): string[] => {
	if (overview.rows.length === 0) {
		return [];
	}
	const maxRows = options?.maxRows ?? 6;
	const ageMs = Math.max(0, (options?.nowMs ?? overview.atMs) - overview.atMs);

	const chips = OVERVIEW_KIND_ORDER.flatMap((kind) => {
		const count = overview.counts[kind];
		if (count === 0) {
			return [];
		}
		const style = KIND_STYLES[kind];
		return [paint(theme, style.glyphRole, style.bold, `${style.glyph} ${count}`)];
	});
	const header = `${theme.fg("dim", "subagents")}  ${chips.join("  ")}`;

	const sortedRows = [...overview.rows].sort(
		(left, right) =>
			sortRank(left.kind) - sortRank(right.kind) || left.name.localeCompare(right.name),
	);
	const visibleRows = sortedRows.slice(0, Math.max(0, maxRows));
	const nameWidth = visibleRows.reduce(
		(widest, row) => Math.max(widest, truncateName(row.name).length),
		0,
	);

	const lines = [header];
	for (const row of visibleRows) {
		const style = KIND_STYLES[row.kind];
		const glyph = paint(theme, style.glyphRole, style.bold, style.glyph);
		const name = paint(theme, style.nameRole, style.bold, truncateName(row.name).padEnd(nameWidth));
		const elapsed = theme.fg(
			"dim",
			formatElapsed(row.elapsedMs === undefined ? undefined : row.elapsedMs + ageMs),
		);
		const suffix = row.kind === "blocked" ? `  ${paint(theme, "warning", true, "blocked")}` : "";
		lines.push(`  ${glyph} ${name}  ${elapsed}${suffix}`);
	}

	const moreCount = sortedRows.length - visibleRows.length;
	if (moreCount > 0) {
		lines.push(`  ${theme.fg("dim", `+${moreCount} more`)}`);
	}
	return lines;
};
