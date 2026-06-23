import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";
import { getStatusLineState, StatusLineStateStore } from "../core/state";
import { LSP_STATUS, LspStatus, type LspClientSnapshot } from "./state";

const LspClientStateSchema = Schema.Struct({ id: Schema.String, label: Schema.String });
const LspEventSchema = Schema.Struct({
	running: Schema.Array(LspClientStateSchema),
	broken: Schema.Array(LspClientStateSchema),
});
const decodeLspEventOption = Schema.decodeUnknownOption(LspEventSchema);

/** Segment that renders LSP runtime status. */
export const lspSegment: StatusLineSegment = {
	id: "lsp",
	order: 50,
	dropPriority: 40,
	render: ({ snapshot, context }) => {
		const status = getStatusLineState(snapshot, LSP_STATUS);
		const running = LspStatus.$is("Running")(status) ? status.running.map(shortLspName) : [];
		const broken = LspStatus.$is("Running")(status) ? status.broken.map(shortLspName) : [];
		const color = lspColor(status, running.length, broken.length);
		const label = running.length > 0 ? `LSP (${running.join(", ")})` : "LSP (Not running)";
		const brokenLabel = broken.length > 0 ? ` !(${broken.join(", ")})` : "";
		const compactLabel = broken.length > 0 ? "LSP!" : running.length > 0 ? "LSP✓" : "LSP–";

		return Option.some({
			full: context.theme.fg(color, `${label}${brokenLabel}`),
			compact: context.theme.fg(color, compactLabel),
		});
	},
};

/** LSP feature: consumes `lsp:status` events and renders language server status. */
export const lspFeature: StatusLineFeature = {
	id: "lsp",
	segments: [lspSegment],
	bind: ({ pi, getRuntime }) => {
		pi.events.on("lsp:status", (payload) => {
			getRuntime()?.run(updateLspStatus(payload));
		});
	},
};

/** Update LSP status from an unknown `lsp:status` event payload. */
export const updateLspStatus: (
	payload: unknown,
) => Effect.Effect<void, never, StatusLineStateStore> = Effect.fn("statusline.updateLspStatus")(
	function* (payload: unknown) {
		const decoded = decodeLspStatusEvent(payload);
		if (Option.isNone(decoded)) return;
		const store = yield* StatusLineStateStore;
		yield* store.set(LSP_STATUS, lspStatusFromEvent(decoded.value));
	},
);

/** Decode an unknown `lsp:status` event payload. */
export function decodeLspStatusEvent(payload: unknown): Option.Option<{
	readonly running: ReadonlyArray<LspClientSnapshot>;
	readonly broken: ReadonlyArray<LspClientSnapshot>;
}> {
	return decodeLspEventOption(payload);
}

/** Convert a decoded LSP event into feature state. */
export function lspStatusFromEvent(event: {
	readonly running: ReadonlyArray<LspClientSnapshot>;
	readonly broken: ReadonlyArray<LspClientSnapshot>;
}): LspStatus {
	if (event.running.length === 0 && event.broken.length === 0) return LspStatus.NotRunning();
	return LspStatus.Running({ running: event.running, broken: event.broken });
}

const lspColor = (status: LspStatus, runningCount: number, brokenCount: number): ThemeColor => {
	if (LspStatus.$is("Unknown")(status)) return "dim";
	if (brokenCount > 0) return "warning";
	if (runningCount > 0) return "success";
	return "dim";
};

const shortLspName = (client: LspClientSnapshot): string => {
	switch (client.id) {
		case "typescript":
			return "TS";
		case "rust-analyzer":
			return "Rust";
		case "pyright":
			return "Python";
		case "gopls":
			return "Go";
		case "bash-language-server":
			return "Shell";
		case "json":
			return "JSON";
		case "css":
			return "CSS";
		case "html":
			return "HTML";
		case "eslint":
			return "ESLint";
		case "yaml":
			return "YAML";
		default:
			return client.label || client.id;
	}
};
