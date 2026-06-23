import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

import { buildContextUsageRegion } from "./context-usage";
import type { StatusLineFeature } from "./core/feature";
import { renderStatusLine } from "./core/layout";
import { makeStatusLineRenderContext } from "./core/render-context";
import { StatusLineRuntime } from "./core/runtime";
import { directoryFeature } from "./directory";
import { effortFeature } from "./effort";
import { lspFeature } from "./lsp";
import { mcpFeature } from "./mcp";
import { modelFeature } from "./model";
import { repositoryFeature } from "./repository";
import { sessionFeature } from "./session";

const STATUS_LINE_FEATURES: ReadonlyArray<StatusLineFeature> = [
	modelFeature,
	effortFeature,
	directoryFeature,
	repositoryFeature,
	lspFeature,
	mcpFeature,
	sessionFeature,
];

const STATUS_LINE_SEGMENTS = STATUS_LINE_FEATURES.flatMap((feature) => feature.segments ?? []);

/** Register the modular Effect-first status line extension. */
export default function statusLineExtension(pi: ExtensionAPI) {
	let runtime: StatusLineRuntime | undefined;

	for (const feature of STATUS_LINE_FEATURES) {
		feature.bind?.({ pi, getRuntime: () => runtime });
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const current = StatusLineRuntime.make(pi, ctx, STATUS_LINE_FEATURES);
		runtime = current;
		current.start();

		ctx.ui.setWidget(
			"statusline",
			(tui, theme) => {
				current.setRenderSink(() => tui.requestRender());
				return {
					dispose() {
						if (runtime === current) current.setRenderSink(undefined);
					},
					invalidate() {},
					render(width: number): string[] {
						const renderContext = makeStatusLineRenderContext(pi, ctx, theme, width);
						return renderStatusLine({
							segments: STATUS_LINE_SEGMENTS,
							snapshot: current.snapshot(),
							context: renderContext,
							rightRegion: buildContextUsageRegion(renderContext),
						});
					},
				};
			},
			{ placement: "belowEditor" },
		);

		// Suppress pi's built-in footer while harvesting extension statuses from footer data.
		ctx.ui.setFooter((_tui, _theme, footerData: ReadonlyFooterDataProvider) => {
			current.updateFooterData(footerData);
			return {
				dispose() {
					if (runtime === current) current.updateFooterData(undefined);
				},
				invalidate() {
					current.updateFooterData(footerData);
				},
				render(): string[] {
					// pi redraws the (suppressed) footer when extension statuses change but does
					// not call invalidate() for data changes, so re-read footer data here to keep
					// MCP status live. The snapshot store dedupes, so unchanged data is a no-op.
					current.updateFooterData(footerData);
					return [];
				},
			};
		});
	});

	pi.on("turn_end", () => {
		runtime?.refreshNow();
	});

	pi.on("session_shutdown", async () => {
		const current = runtime;
		runtime = undefined;
		if (current !== undefined) await current.shutdown();
	});
}
