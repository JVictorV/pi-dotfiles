import { Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";

import { prettyModelName } from "./model-name";

/** Segment that renders the active model name. */
export const modelSegment: StatusLineSegment = {
	id: "model",
	order: 0,
	dropPriority: 0,
	required: true,
	render: ({ context }) =>
		Option.some({
			full: context.theme.fg(
				"accent",
				context.modelId ? prettyModelName(context.modelId) : "no-model",
			),
		}),
};

/** Model feature: renders the active model name. */
export const modelFeature: StatusLineFeature = {
	id: "model",
	segments: [modelSegment],
};
