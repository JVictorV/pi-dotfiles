import { Data } from "effect";

import { makeStatusLineStateKey } from "../core/state";

/** Claude Fable model id whose classifier fallback routing is shown in the status line. */
export const FABLE_MODEL_ID = "claude-fable-5";

/** Default fallback model Anthropic documents for Claude Fable classifier declines. */
export const FABLE_FALLBACK_MODEL_ID = "claude-opus-4-8";

/** Routing state for the most recent Claude Fable provider request. */
export type FableRoutingStatus = Data.TaggedEnum<{
	Ready: {};
	Checking: {};
	Direct: {};
	Rerouted: { readonly model: string };
	Refused: { readonly explanation: string | null };
	Error: { readonly message: string };
}>;

/** Constructors and matchers for {@link FableRoutingStatus}. */
export const FableRoutingStatus = Data.taggedEnum<FableRoutingStatus>();

/** State key for the Claude Fable routing feature. */
export const FABLE_ROUTING_STATUS = makeStatusLineStateKey<FableRoutingStatus>({
	id: "fable-routing",
	initial: FableRoutingStatus.Ready(),
	equals: fableRoutingStatusEquals,
});

/** Compare Claude Fable routing states. */
export function fableRoutingStatusEquals(
	left: FableRoutingStatus,
	right: FableRoutingStatus,
): boolean {
	return FableRoutingStatus.$match(left, {
		Ready: () => FableRoutingStatus.$is("Ready")(right),
		Checking: () => FableRoutingStatus.$is("Checking")(right),
		Direct: () => FableRoutingStatus.$is("Direct")(right),
		Rerouted: (rerouted) =>
			FableRoutingStatus.$is("Rerouted")(right) && rerouted.model === right.model,
		Refused: (refused) =>
			FableRoutingStatus.$is("Refused")(right) && refused.explanation === right.explanation,
		Error: (failure) => FableRoutingStatus.$is("Error")(right) && failure.message === right.message,
	});
}
