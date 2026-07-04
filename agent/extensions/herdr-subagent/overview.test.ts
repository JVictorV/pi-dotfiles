import { describe, expect, test } from "vitest";

import type { HerdrAgent } from "./schemas";
import { buildOverview, renderOverviewLines, type Overview, type OverviewRow } from "./overview";
import { matchEntriesToAgents } from "./store";
import type { RegistryEntry } from "./types";

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

	test("uses matched live agent status and pane id", () => {
		const result = buildOverview(
			[entry({ name: "worker", terminalId: "term-1" })],
			[agent({ terminal_id: "term-1", pane_id: "pane-1", agent_status: "working" })],
			BASE_TIME + 45_000,
		);

		expect(result.rows).toEqual([
			{ name: "worker", kind: "working", elapsedMs: 45_000, paneId: "pane-1" },
		]);
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

describe("renderOverviewLines", () => {
	test("renders no lines when there are no rows", () => {
		expect(renderOverviewLines(overview([]))).toEqual([]);
	});

	test("formats nonzero header counts in canonical order", () => {
		const lines = renderOverviewLines(
			overview([
				{ name: "done", kind: "done", elapsedMs: 1_000 },
				{ name: "blocked", kind: "blocked", elapsedMs: 1_000 },
				{ name: "working", kind: "working", elapsedMs: 1_000 },
				{ name: "spawning", kind: "spawning", elapsedMs: 1_000 },
			]),
		);

		expect(lines[0]).toBe("subagents: 1 blocked · 1 working · 1 spawning · 1 done");
	});

	test("sorts blocked rows before working rows and includes glyphs", () => {
		const lines = renderOverviewLines(
			overview([
				{ name: "work", kind: "working", elapsedMs: 45_000, paneId: "pane-work" },
				{ name: "block", kind: "blocked", elapsedMs: 45_000, paneId: "pane-block" },
				{ name: "spawn", kind: "spawning", elapsedMs: 45_000 },
				{ name: "done", kind: "done", elapsedMs: 45_000 },
				{ name: "idle", kind: "idle", elapsedMs: 45_000 },
				{ name: "mystery", kind: "unknown", elapsedMs: 45_000 },
				{ name: "lost", kind: "missing", elapsedMs: 45_000 },
			]),
			10,
		);

		expect(lines[1]).toContain("⚠ block");
		expect(lines[2]).toContain("⚙ work");
		expect(lines.join("\n")).toContain("… spawn");
		expect(lines.join("\n")).toContain("✓ done");
		expect(lines.join("\n")).toContain("○ idle");
		expect(lines.join("\n")).toContain("? mystery");
		expect(lines.join("\n")).toContain("✗ lost");
	});

	test("truncates long names, pads elapsed, and trims trailing whitespace", () => {
		const lines = renderOverviewLines(
			overview([
				{
					name: "very-long-subagent-name",
					kind: "working",
					elapsedMs: 45_000,
					paneId: "pane-long",
				},
				{ name: "none", kind: "idle" },
			]),
			10,
		);

		expect(lines[1]).toBe("  ⚙ very-long-subagent-… working  45s    pane-long");
		expect(lines[2]).toBe("  ○ none                 idle     -");
		expect(lines[2]?.endsWith(" ")).toBe(false);
	});

	test("truncates rows and appends a status hint", () => {
		const lines = renderOverviewLines(
			overview([
				{ name: "a", kind: "working" },
				{ name: "b", kind: "working" },
				{ name: "c", kind: "working" },
				{ name: "d", kind: "working" },
			]),
			2,
		);

		expect(lines).toHaveLength(4);
		expect(lines.at(-1)).toBe("  +2 more (use herdr_subagent status)");
	});

	test("humanizes elapsed durations", () => {
		const lines = renderOverviewLines(
			overview([
				{ name: "seconds", kind: "working", elapsedMs: 45_000 },
				{ name: "minutes", kind: "working", elapsedMs: 192_000 },
				{ name: "hours", kind: "working", elapsedMs: 3_840_000 },
				{ name: "none", kind: "working" },
			]),
			10,
		);

		expect(lines.join("\n")).toContain("45s");
		expect(lines.join("\n")).toContain("3m12s");
		expect(lines.join("\n")).toContain("1h04m");
		expect(lines.join("\n")).toContain("none                 working  -");
	});
});
