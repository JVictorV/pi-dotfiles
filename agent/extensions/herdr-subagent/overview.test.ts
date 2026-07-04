import { describe, expect, test } from "vitest";

import type { HerdrAgent } from "./schemas";
import {
	buildOverview,
	type Overview,
	type OverviewRow,
	type OverviewTheme,
	renderOverview,
} from "./overview";
import { matchEntriesToAgents } from "./store";
import type { RegistryEntry } from "./types";

/**
 * Theme fake that tags text with its color role and bold state so tests can
 * assert both layout structure and the theme role assigned to each segment.
 */
const tagTheme: OverviewTheme = {
	fg: (role, text) => `[${role}]${text}[/${role}]`,
	bold: (text) => `<b>${text}</b>`,
};

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const BASE_TIME_ISO = new Date(BASE_TIME).toISOString();

const entry = (overrides: Partial<RegistryEntry> & { readonly name: string }): RegistryEntry => ({
	cwd: "/workspace",
	label: `agent: ${overrides.name}`,
	taskFile: `/tmp/${overrides.name}.md`,
	createdAt: BASE_TIME_ISO,
	updatedAt: BASE_TIME_ISO,
	...overrides,
});

const agent = (overrides: HerdrAgent): HerdrAgent => overrides;

const overview = (rows: ReadonlyArray<OverviewRow>): Overview => {
	const counts = {
		working: 0,
		blocked: 0,
		idle: 0,
		done: 0,
		unknown: 0,
		missing: 0,
		spawning: 0,
	};
	for (const row of rows) {
		counts[row.kind] += 1;
	}
	return { rows, counts };
};

describe("matchEntriesToAgents", () => {
	test("prioritizes terminal id matches over hint matches", () => {
		const matches = matchEntriesToAgents(
			[
				entry({ name: "durable", terminalId: "term-1", paneId: "pane-1" }),
				entry({ name: "legacy", target: "term-1", paneId: "pane-1" }),
			],
			[agent({ terminal_id: "term-1", pane_id: "pane-1" })],
		);

		expect(matches[0]?.entry?.name).toBe("durable");
		expect(matches[1]?.entry?.name).toBe("legacy");
		expect(matches[1]?.agent).toBeUndefined();
	});

	test("uses pane, tab, and target hints only for legacy entries without terminal ids", () => {
		const matches = matchEntriesToAgents(
			[
				entry({ name: "durable", terminalId: "other-term", paneId: "pane-1" }),
				entry({ name: "legacy", target: "term-1", tabId: "tab-1" }),
			],
			[agent({ terminal_id: "term-1", pane_id: "pane-1", tab_id: "tab-1" })],
		);

		expect(matches[0]?.entry?.name).toBe("legacy");
		expect(matches[1]?.entry?.name).toBe("durable");
		expect(matches[1]?.agent).toBeUndefined();
	});

	test("attaches each registry entry to at most one live agent", () => {
		const matches = matchEntriesToAgents(
			[entry({ name: "worker", terminalId: "term-1" })],
			[
				agent({ terminal_id: "term-1", pane_id: "pane-1" }),
				agent({ terminal_id: "term-1", pane_id: "pane-2" }),
			],
		);

		expect(matches[0]?.entry?.name).toBe("worker");
		expect(matches[1]?.entry).toBeUndefined();
		expect(matches).toHaveLength(2);
	});
});

describe("buildOverview", () => {
	test("maps reserved entries to spawning", () => {
		const result = buildOverview([entry({ name: "new", phase: "reserved" })], [], BASE_TIME);

		expect(result.rows).toMatchObject([{ name: "new", kind: "spawning" }]);
		expect(result.counts.spawning).toBe(1);
	});

	test("uses matched live agent status without exposing the pane id", () => {
		const result = buildOverview(
			[entry({ name: "worker", terminalId: "term-1" })],
			[agent({ terminal_id: "term-1", pane_id: "pane-1", agent_status: "working" })],
			BASE_TIME + 45_000,
		);

		expect(result.rows).toEqual([{ name: "worker", kind: "working", elapsedMs: 45_000 }]);
		expect(result.rows[0]).not.toHaveProperty("paneId");
	});

	test("matches by hints only for terminal-id-less entries", () => {
		const result = buildOverview(
			[
				entry({ name: "durable", terminalId: "other-term", paneId: "pane-1" }),
				entry({ name: "legacy", paneId: "pane-1" }),
			],
			[agent({ pane_id: "pane-1", agent_status: "idle" })],
			BASE_TIME,
		);

		expect(result.rows.map((row) => [row.name, row.kind])).toEqual([
			["legacy", "idle"],
			["durable", "missing"],
		]);
	});

	test("marks unmatched active entries missing and ignores foreign live agents", () => {
		const result = buildOverview(
			[entry({ name: "ours", phase: "active", terminalId: "term-ours" })],
			[agent({ terminal_id: "term-foreign", pane_id: "pane-foreign", agent_status: "blocked" })],
			BASE_TIME,
		);

		expect(result.rows).toMatchObject([{ name: "ours", kind: "missing" }]);
		expect(result.rows).toHaveLength(1);
		expect(result.counts.blocked).toBe(0);
		expect(result.counts.missing).toBe(1);
	});

	test("clamps negative elapsed time and leaves invalid createdAt undefined", () => {
		const result = buildOverview(
			[
				entry({ name: "future", createdAt: new Date(BASE_TIME + 1_000).toISOString() }),
				entry({ name: "invalid", createdAt: "not-a-date" }),
			],
			[],
			BASE_TIME,
		);

		expect(result.rows.find((row) => row.name === "future")?.elapsedMs).toBe(0);
		expect(result.rows.find((row) => row.name === "invalid")?.elapsedMs).toBeUndefined();
	});
});

describe("renderOverview", () => {
	test("renders no lines when there are no rows", () => {
		expect(renderOverview(overview([]), tagTheme)).toEqual([]);
	});

	test("colors header count chips per kind in canonical order", () => {
		const header = renderOverview(
			overview([
				{ name: "done", kind: "done", elapsedMs: 1_000 },
				{ name: "blocked", kind: "blocked", elapsedMs: 1_000 },
				{ name: "working", kind: "working", elapsedMs: 1_000 },
				{ name: "spawning", kind: "spawning", elapsedMs: 1_000 },
			]),
			tagTheme,
		)[0];

		expect(header).toContain("[dim]subagents[/dim]");
		// Blocked chip pops: warning + bold.
		expect(header).toContain("[warning]<b>⚠ 1</b>[/warning]");
		expect(header).toContain("[accent]● 1[/accent]");
		expect(header).toContain("[dim]◌ 1[/dim]");
		expect(header).toContain("[success]✓ 1[/success]");
		// Canonical order: blocked, then working, then spawning, then done.
		const indices = ["⚠ 1", "● 1", "◌ 1", "✓ 1"].map((chip) => header?.indexOf(chip) ?? -1);
		expect(indices).toEqual([...indices].sort((a, b) => a - b));
		expect(indices.every((index) => index >= 0)).toBe(true);
	});

	test("sorts blocked rows first and assigns each kind its glyph and theme role", () => {
		const lines = renderOverview(
			overview([
				{ name: "work", kind: "working", elapsedMs: 45_000 },
				{ name: "block", kind: "blocked", elapsedMs: 45_000 },
				{ name: "spawn", kind: "spawning", elapsedMs: 45_000 },
				{ name: "finished", kind: "done", elapsedMs: 45_000 },
				{ name: "waiting", kind: "idle", elapsedMs: 45_000 },
				{ name: "mystery", kind: "unknown", elapsedMs: 45_000 },
				{ name: "lost", kind: "missing", elapsedMs: 45_000 },
			]),
			tagTheme,
			10,
		);
		const body = lines.slice(1).join("\n");

		// Blocked sorts to the first row, painted warning + bold, and spelled out.
		expect(lines[1]).toContain("[warning]<b>⚠</b>[/warning]");
		expect(lines[1]).toContain("[warning]<b>block");
		expect(lines[1]).toContain("[warning]<b>blocked</b>[/warning]");
		// Working sorts next and is accent.
		expect(lines[2]).toContain("[accent]●[/accent]");
		expect(lines[2]).toContain("[accent]work");
		// Done keeps a success glyph but a de-emphasized (muted) name.
		expect(body).toContain("[success]✓[/success]");
		expect(body).toContain("[muted]finished");
		// Remaining kinds keep their glyph + role.
		expect(body).toContain("[dim]◌[/dim]");
		expect(body).toContain("[muted]○[/muted]");
		expect(body).toContain("[dim]?[/dim]");
		expect(body).toContain("[error]✗[/error]");
	});

	test("never renders a pane id", () => {
		const lines = renderOverview(
			overview([{ name: "worker", kind: "working", elapsedMs: 45_000 }]),
			tagTheme,
		);

		expect(lines.join("\n")).not.toMatch(/pane|w\d+:p/i);
	});

	test("paints elapsed dim and spells out blocked only for blocked rows", () => {
		const lines = renderOverview(
			overview([
				{ name: "stuck", kind: "blocked", elapsedMs: 45_000 },
				{ name: "busy", kind: "working", elapsedMs: 45_000 },
			]),
			tagTheme,
			10,
		);

		expect(lines[1]).toContain("[dim]45s[/dim]");
		expect(lines[1]).toContain("[warning]<b>blocked</b>[/warning]");
		expect(lines[2]).toContain("[dim]45s[/dim]");
		expect(lines[2]).not.toContain("blocked");
	});

	test("truncates long names with an ellipsis", () => {
		const lines = renderOverview(
			overview([{ name: "very-long-subagent-name-that-overflows", kind: "working" }]),
			tagTheme,
		);

		expect(lines[1]).toContain("very-long-subagent-na…");
	});

	test("truncates rows and appends a dim status hint", () => {
		const lines = renderOverview(
			overview([
				{ name: "a", kind: "working" },
				{ name: "b", kind: "working" },
				{ name: "c", kind: "working" },
				{ name: "d", kind: "working" },
			]),
			tagTheme,
			2,
		);

		expect(lines).toHaveLength(4);
		expect(lines.at(-1)).toBe("  [dim]+2 more · herdr_subagent status[/dim]");
	});

	test("humanizes elapsed durations", () => {
		const body = renderOverview(
			overview([
				{ name: "seconds", kind: "working", elapsedMs: 45_000 },
				{ name: "minutes", kind: "working", elapsedMs: 192_000 },
				{ name: "hours", kind: "working", elapsedMs: 3_840_000 },
				{ name: "none", kind: "working" },
			]),
			tagTheme,
			10,
		).join("\n");

		expect(body).toContain("[dim]45s[/dim]");
		expect(body).toContain("[dim]3m12s[/dim]");
		expect(body).toContain("[dim]1h04m[/dim]");
		expect(body).toContain("[dim]-[/dim]");
	});
});
