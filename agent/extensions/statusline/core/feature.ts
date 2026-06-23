import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";

import type { StatusLineRuntime } from "./runtime";
import type { StatusLineSegment } from "./segment";
import type { StatusLineShell } from "./shell";
import type { StatusLineStateStore } from "./state";

/** Core Effect services available to status-line features. */
export type StatusLineCoreServices = StatusLineShell | StatusLineStateStore;

/** Inputs for binding a feature to pi events outside the render path. */
export type StatusLineFeatureBinding = {
	readonly pi: ExtensionAPI;
	getRuntime(): StatusLineRuntime | undefined;
};

/** A vertical status-line feature: state source hooks plus visual segments. */
export type StatusLineFeature = {
	readonly id: string;
	readonly segments?: ReadonlyArray<StatusLineSegment>;
	readonly start?: Effect.Effect<void, never, StatusLineCoreServices>;
	readonly onTurnEnd?: Effect.Effect<void, never, StatusLineCoreServices>;
	onFooterData?(
		data: ReadonlyFooterDataProvider | undefined,
	): Effect.Effect<void, never, StatusLineCoreServices>;
	bind?(binding: StatusLineFeatureBinding): void;
};
