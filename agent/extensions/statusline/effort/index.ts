import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { ThinkingLevel } from "../core/render-context";
import type { StatusLineSegment } from "../core/segment";

const THINKING_COLOR: Record<ThinkingLevel, ThemeColor> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

/** Segment that renders the active thinking/effort level. */
export const effortSegment: StatusLineSegment = {
	id: "effort",
	order: 10,
	dropPriority: 5,
	render: ({ context }) => {
		if (!context.thinking || context.thinking === "off") return Option.none();
		return Option.some({
			full: context.theme.fg(THINKING_COLOR[context.thinking], context.thinking),
		});
	},
};

/** Effort feature: renders the active thinking/effort level. */
export const effortFeature: StatusLineFeature = {
	id: "effort",
	segments: [effortSegment],
};
