import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Option } from "effect";

import type { StatusLineRenderContext } from "./render-context";
import type { StatusLineSegment, StatusLineSegmentInput, StatusLineSegmentView } from "./segment";
import type { StatusLineSnapshot } from "./state";

const LEFT_SEPARATOR = "│";

/** Minimal theme capability needed by status-line layout. */
export type StatusLineLayoutTheme = {
	fg(color: ThemeColor, text: string): string;
};

type SegmentVariant = "full" | "compact" | "minimal";

const SEGMENT_VARIANTS: ReadonlyArray<SegmentVariant> = ["full", "compact", "minimal"];

type RenderStatusLineInput = {
	readonly segments: ReadonlyArray<StatusLineSegment>;
	readonly snapshot: StatusLineSnapshot;
	readonly context: StatusLineRenderContext;
	readonly rightRegion: string;
};

/** Render the full single-line status line. */
export function renderStatusLine(input: RenderStatusLineInput): string[] {
	const { context, rightRegion } = input;
	const left = buildLeft(
		context.theme,
		renderSegmentViews(input.segments, {
			snapshot: input.snapshot,
			context,
		}),
		Math.max(0, context.width - visibleWidth(rightRegion) - 1),
	);
	return [layoutStatusLine(context.theme, left, rightRegion, context.width)];
}

/** Render all active segment views, sorted by display order. */
export function renderSegmentViews(
	segments: ReadonlyArray<StatusLineSegment>,
	input: StatusLineSegmentInput,
): ReadonlyArray<StatusLineSegmentView> {
	return segments
		.flatMap((segment) => {
			const content = segment.render(input);
			if (Option.isNone(content)) return [];
			return [
				{
					...content.value,
					id: segment.id,
					order: segment.order,
					dropPriority: segment.dropPriority,
					required: segment.required === true,
				} satisfies StatusLineSegmentView,
			];
		})
		.sort((left, right) => left.order - right.order);
}

/** Build the left side, compacting/dropping optional segments to fit `availableWidth`. */
export function buildLeft(
	theme: StatusLineLayoutTheme,
	segments: ReadonlyArray<StatusLineSegmentView>,
	availableWidth: number,
): string {
	if (availableWidth <= 0 || segments.length === 0) return "";

	for (const variant of SEGMENT_VARIANTS) {
		const rendered = renderVariantSegments(segments, variant);
		const joined = joinSegments(theme, rendered);
		if (visibleWidth(joined) <= availableWidth) return joined;
	}

	const remaining = renderVariantSegments(segments, "minimal");
	while (visibleWidth(joinSegments(theme, remaining)) > availableWidth) {
		const removalIndex = chooseRemovalIndex(remaining);
		if (removalIndex === undefined) break;
		remaining.splice(removalIndex, 1);
	}

	const responsive = joinSegments(theme, remaining);
	if (visibleWidth(responsive) <= availableWidth) return responsive;
	return truncateToWidth(responsive, availableWidth, theme.fg("dim", "…"));
}

/** Join left/right into a single padded line, preserving the right side when space is tight. */
export function layoutStatusLine(
	theme: StatusLineLayoutTheme,
	left: string,
	right: string,
	width: number,
): string {
	if (width <= 0) return "";
	if (!left) return truncateToWidth(right, width, theme.fg("dim", "…"));

	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, theme.fg("dim", "…"));

	const gap = Math.max(1, width - visibleWidth(left) - rightWidth);
	return truncateToWidth(left + " ".repeat(gap) + right, width, "");
}

const renderVariantSegments = (
	segments: ReadonlyArray<StatusLineSegmentView>,
	variant: SegmentVariant,
): Array<StatusLineSegmentView & { readonly text: string }> =>
	segments.map((segment) => ({
		...segment,
		text: segment[variant] ?? segment.compact ?? segment.full,
	}));

const joinSegments = (
	theme: StatusLineLayoutTheme,
	segments: ReadonlyArray<{ readonly text: string }>,
): string => segments.map((segment) => segment.text).join(theme.fg("dim", ` ${LEFT_SEPARATOR} `));

const chooseRemovalIndex = (
	segments: ReadonlyArray<StatusLineSegmentView & { readonly text: string }>,
): number | undefined => {
	let selectedIndex: number | undefined;
	let selectedPriority = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment || segment.required) continue;
		if (segment.dropPriority >= selectedPriority) {
			selectedIndex = index;
			selectedPriority = segment.dropPriority;
		}
	}

	return selectedIndex;
};
