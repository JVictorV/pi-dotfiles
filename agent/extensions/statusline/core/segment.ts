import type { Option } from "effect";

import type { StatusLineRenderContext } from "./render-context";
import type { StatusLineSnapshot } from "./state";

/** Closed internal identifiers for status-line visual segments. */
export type StatusLineSegmentId =
	| "model"
	| "effort"
	| "fable-routing"
	| "directory"
	| "git"
	| "pull-request"
	| "lsp"
	| "mcp"
	| "session";

/** Render input shared by all status-line segments. */
export type StatusLineSegmentInput = {
	readonly snapshot: StatusLineSnapshot;
	readonly context: StatusLineRenderContext;
};

/** Display variants produced by a segment when it has content. */
export type StatusLineSegmentContent = {
	readonly full: string;
	readonly compact?: string;
	readonly minimal?: string;
};

/** A modular visual contribution to the status line. */
export type StatusLineSegment = {
	readonly id: StatusLineSegmentId;
	readonly order: number;
	readonly dropPriority: number;
	readonly required?: boolean;
	render(input: StatusLineSegmentInput): Option.Option<StatusLineSegmentContent>;
};

/** Segment content with stable layout metadata attached. */
export type StatusLineSegmentView = StatusLineSegmentContent & {
	readonly id: StatusLineSegmentId;
	readonly order: number;
	readonly dropPriority: number;
	readonly required: boolean;
};
