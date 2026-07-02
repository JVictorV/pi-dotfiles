// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
// oxlint-disable effect/no-type-casting -- SAFETY: Focused tests build the narrow render context needed by the fable segment and cast it at the boundary.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import type { StatusLineRenderContext } from "../core/render-context";
import { fableRoutingSegment, fableRoutingStatusFromEvent } from "./index";
import { FABLE_MODEL_ID, FABLE_ROUTING_STATUS, FableRoutingStatus } from "./state";

const identityTheme = { fg: (_color: string, value: string) => value } as unknown as Theme;

function renderFableSegment(
	modelId: string | undefined,
	status: FableRoutingStatus,
): string | undefined {
	const context = {
		theme: identityTheme,
		width: 120,
		modelId,
		thinking: "off",
		cwd: "/tmp/project",
		sessionName: undefined,
		contextUsage: { tokens: null, contextWindow: 200000, percent: null },
		terminal: { hyperlinks: false },
	} as StatusLineRenderContext;

	const rendered = fableRoutingSegment.render({
		snapshot: new Map([[FABLE_ROUTING_STATUS.id, status]]),
		context,
	});
	return Option.isSome(rendered) ? rendered.value.full : undefined;
}

describe("Claude Fable routing status", () => {
	test("maps observer events to status states", () => {
		expect(
			FableRoutingStatus.$is("Checking")(fableRoutingStatusFromEvent({ type: "request" })),
		).toBe(true);
		expect(FableRoutingStatus.$is("Direct")(fableRoutingStatusFromEvent({ type: "direct" }))).toBe(
			true,
		);
		expect(
			FableRoutingStatus.$is("Rerouted")(
				fableRoutingStatusFromEvent({ type: "fallback", model: "claude-opus-4-8" }),
			),
		).toBe(true);
	});

	test("renders only when Claude Fable is the selected model", () => {
		expect(renderFableSegment("claude-opus-4-8", FableRoutingStatus.Direct())).toBeUndefined();
		expect(renderFableSegment(FABLE_MODEL_ID, FableRoutingStatus.Direct())).toBe("Fable ☺");
	});

	test("shows the fallback model when a request is rerouted", () => {
		expect(
			renderFableSegment(FABLE_MODEL_ID, FableRoutingStatus.Rerouted({ model: "claude-opus-4-8" })),
		).toBe("Opus 4.8 ☹");
	});
});
