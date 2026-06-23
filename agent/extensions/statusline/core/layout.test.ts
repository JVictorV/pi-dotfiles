// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { stripAnsi } from "./ansi";
import { buildLeft, layoutStatusLine, type StatusLineLayoutTheme } from "./layout";
import type { StatusLineSegmentView } from "./segment";

const theme = {
	fg: (_color: ThemeColor, value: string) => value,
} satisfies StatusLineLayoutTheme;

describe("status-line layout", () => {
	test("uses compact segment variants before dropping optional segments", () => {
		const segments: ReadonlyArray<StatusLineSegmentView> = [
			{
				id: "model",
				order: 0,
				dropPriority: 0,
				required: true,
				full: "Model",
			},
			{
				id: "directory",
				order: 20,
				dropPriority: 10,
				required: false,
				full: "/Users/example/project",
				compact: "~/project",
			},
			{
				id: "session",
				order: 70,
				dropPriority: 60,
				required: false,
				full: "session",
			},
		];

		expect(buildLeft(theme, segments, 30)).toBe("Model │ ~/project │ session");
	});

	test("drops higher drop-priority optional segments first", () => {
		const segments: ReadonlyArray<StatusLineSegmentView> = [
			{
				id: "model",
				order: 0,
				dropPriority: 0,
				required: true,
				full: "Model",
			},
			{
				id: "directory",
				order: 20,
				dropPriority: 10,
				required: false,
				full: "/very/long/project",
				compact: "~p",
				minimal: "~p",
			},
			{
				id: "session",
				order: 70,
				dropPriority: 60,
				required: false,
				full: "Long Session",
				compact: "S",
				minimal: "S",
			},
		];

		expect(buildLeft(theme, segments, 10)).toBe("Model │ ~p");
	});

	test("preserves the right region when width is tight", () => {
		expect(stripAnsi(layoutStatusLine(theme, "Left", "RIGHT", 4))).toBe("RIG…");
	});
});
