import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Effect, Match, Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";
import { getStatusLineState, StatusLineStateStore } from "../core/state";
import {
	installFableRoutingFetchObserver,
	subscribeToFableRoutingEvents,
	type FableRoutingEvent,
} from "./fetch-observer";
import {
	FABLE_FALLBACK_MODEL_ID,
	FABLE_MODEL_ID,
	FABLE_ROUTING_STATUS,
	FableRoutingStatus,
} from "./state";

/** Segment that renders Claude Fable classifier fallback routing status. */
export const fableRoutingSegment: StatusLineSegment = {
	id: "fable-routing",
	order: 20,
	dropPriority: 10,
	render: ({ snapshot, context }) => {
		if (context.modelId !== FABLE_MODEL_ID) return Option.none();
		const status = getStatusLineState(snapshot, FABLE_ROUTING_STATUS);
		const content = fableRoutingContent(status);
		return Option.some({
			full: context.theme.fg(content.color, content.full),
			compact: context.theme.fg(content.color, content.compact),
			minimal: context.theme.fg(content.color, content.minimal),
		});
	},
};

/** Claude Fable routing feature: enables server-side fallback and displays route outcomes. */
export const fableRoutingFeature: StatusLineFeature = {
	id: "fable-routing",
	segments: [fableRoutingSegment],
	bind: ({ pi, getRuntime }) => {
		installFableRoutingFetchObserver();

		let unsubscribe: (() => void) | undefined;

		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			unsubscribe?.();
			unsubscribe = subscribeToFableRoutingEvents((event) => {
				getRuntime()?.run(updateFableRoutingStatus(fableRoutingStatusFromEvent(event)));
			});
		});

		pi.on("model_select", (event) => {
			if (event.model.id === FABLE_MODEL_ID) {
				getRuntime()?.run(updateFableRoutingStatus(FableRoutingStatus.Ready()));
			}
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (ctx.model?.id !== FABLE_MODEL_ID || !isFableRequestPayload(event.payload)) return;
			getRuntime()?.run(updateFableRoutingStatus(FableRoutingStatus.Checking()));
			return withFableFallback(event.payload);
		});

		pi.on("session_shutdown", () => {
			unsubscribe?.();
			unsubscribe = undefined;
		});
	},
};

/** Update the Claude Fable routing status-line state. */
export const updateFableRoutingStatus = (
	status: FableRoutingStatus,
): Effect.Effect<void, never, StatusLineStateStore> =>
	StatusLineStateStore.use((store) => store.set(FABLE_ROUTING_STATUS, status).pipe(Effect.asVoid));

/** Convert a fetch-observed routing event into status-line state. */
export function fableRoutingStatusFromEvent(event: FableRoutingEvent): FableRoutingStatus {
	return Match.value(event).pipe(
		Match.when({ type: "request" }, () => FableRoutingStatus.Checking()),
		Match.when({ type: "direct" }, () => FableRoutingStatus.Direct()),
		Match.when({ type: "fallback" }, ({ model }) => FableRoutingStatus.Rerouted({ model })),
		Match.when({ type: "refusal" }, ({ explanation }) =>
			FableRoutingStatus.Refused({ explanation }),
		),
		Match.when({ type: "error" }, ({ message }) => FableRoutingStatus.Error({ message })),
		Match.exhaustive,
	);
}

function isFableRequestPayload(payload: unknown): payload is Readonly<Record<string, unknown>> {
	return isRecord(payload) && payload["model"] === FABLE_MODEL_ID;
}

function withFableFallback(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
	if (payload["fallbacks"] !== undefined) return { ...payload };
	return { ...payload, fallbacks: [{ model: FABLE_FALLBACK_MODEL_ID }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type FableRoutingSegmentContent = {
	readonly full: string;
	readonly compact: string;
	readonly minimal: string;
	readonly color: ThemeColor;
};

const fableRoutingContent = (status: FableRoutingStatus): FableRoutingSegmentContent =>
	FableRoutingStatus.$match(status, {
		Ready: () => makeFableRoutingContent("Fable ☺", "Fable ☺", "☺", "success"),
		Checking: () => makeFableRoutingContent("→ waiting...", "→ waiting...", "…", "warning"),
		Direct: () => makeFableRoutingContent("Fable ☺", "Fable ☺", "☺", "success"),
		Rerouted: (rerouted) =>
			makeFableRoutingContent(
				`${shortModelName(rerouted.model)} ☹`,
				`${shortModelName(rerouted.model)} ☹`,
				"☹",
				"error",
			),
		Refused: () => makeFableRoutingContent("refused ☹", "refused ☹", "!", "error"),
		Error: () => makeFableRoutingContent("route error ☹", "route error ☹", "!", "error"),
	});

const makeFableRoutingContent = (
	full: string,
	compact: string,
	minimal: string,
	color: ThemeColor,
): FableRoutingSegmentContent => ({ full, compact, minimal, color });

function shortModelName(model: string): string {
	if (model === FABLE_FALLBACK_MODEL_ID) return "Opus 4.8";
	return model.replace(/^claude-/u, "").replace(/-/gu, " ");
}
