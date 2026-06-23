import { Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";

/** Segment that renders the current session name. */
export const sessionSegment: StatusLineSegment = {
	id: "session",
	order: 70,
	dropPriority: 60,
	render: ({ context }) => {
		if (!context.sessionName) return Option.none();
		return Option.some({ full: context.theme.fg("dim", context.sessionName) });
	},
};

/** Session feature: renders the current session name. */
export const sessionFeature: StatusLineFeature = {
	id: "session",
	segments: [sessionSegment],
};
