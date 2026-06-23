import { Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";

import { compactPath, shortenHome } from "./path";

/** Segment that renders the current working directory. */
export const directorySegment: StatusLineSegment = {
	id: "directory",
	order: 20,
	dropPriority: 10,
	render: ({ context }) =>
		Option.some({
			full: context.theme.fg("dim", shortenHome(context.cwd)),
			compact: context.theme.fg("dim", compactPath(context.cwd)),
		}),
};

/** Directory feature: renders the current working directory. */
export const directoryFeature: StatusLineFeature = {
	id: "directory",
	segments: [directorySegment],
};
