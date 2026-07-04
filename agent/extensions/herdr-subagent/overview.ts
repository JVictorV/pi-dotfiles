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
	readonly paneId?: string;
}

/** Overview model consumed by the widget renderer. */
export interface Overview {
	readonly rows: ReadonlyArray<OverviewRow>;
	readonly counts: Readonly<Record<OverviewRowKind, number>>;
}

const OVERVIEW_KIND_ORDER: ReadonlyArray<OverviewRowKind> = [
	"blocked",
	"working",
	"spawning",
	"done",
	"idle",
	"unknown",
	"missing",
];

const ROW_SORT_ORDER: ReadonlyArray<OverviewRowKind> = [
	"blocked",
	"working",
	"spawning",
	"done",
	"idle",
	"unknown",
	"missing",
];

const GLYPHS: Readonly<Record<OverviewRowKind, string>> = {
	working: "⚙",
	blocked: "⚠",
	spawning: "…",
	done: "✓",
	idle: "○",
	unknown: "?",
	missing: "✗",
};

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

const formatName = (name: string): string =>
	(name.length > 20 ? `${name.slice(0, 19)}…` : name).padEnd(20);

const formatElapsedColumn = (elapsedMs: number | undefined): string =>
	formatElapsed(elapsedMs).padEnd(6);

const renderRow = (row: OverviewRow): string =>
	`  ${GLYPHS[row.kind]} ${formatName(row.name)} ${row.kind.padEnd(8)} ${formatElapsedColumn(row.elapsedMs)} ${row.paneId ?? ""}`.trimEnd();

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
			paneId: match.agent?.pane_id,
		});
	}

	return { rows, counts };
};

/**
 * Render an overview model as plain widget lines.
 *
 * @param overview - Overview model returned by {@link buildOverview}.
 * @param maxRows - Maximum number of subagent rows to show before truncating.
 * @returns Plain text widget lines, or an empty array when there are no rows.
 */
export const renderOverviewLines = (overview: Overview, maxRows = 6): string[] => {
	if (overview.rows.length === 0) {
		return [];
	}

	const summary = OVERVIEW_KIND_ORDER.flatMap((kind) => {
		const count = overview.counts[kind];
		return count > 0 ? [`${count} ${kind}`] : [];
	}).join(" · ");
	const sortedRows = [...overview.rows].sort(
		(left, right) =>
			sortRank(left.kind) - sortRank(right.kind) || left.name.localeCompare(right.name),
	);
	const visibleRowCount = Math.max(0, maxRows);
	const visibleRows = sortedRows.slice(0, visibleRowCount);
	const moreCount = sortedRows.length - visibleRows.length;
	const lines = [`subagents: ${summary}`, ...visibleRows.map(renderRow)];
	if (moreCount > 0) {
		lines.push(`  +${moreCount} more (use herdr_subagent status)`);
	}
	return lines;
};
