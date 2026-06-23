import type { ReadonlyFooterDataProvider, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Effect, Option } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";
import { getStatusLineState, StatusLineStateStore } from "../core/state";
import { stripAnsi } from "../core/ansi";
import { MCP_STATUS, McpStatus } from "./state";

/** Segment that renders MCP adapter status. */
export const mcpSegment: StatusLineSegment = {
	id: "mcp",
	order: 60,
	dropPriority: 50,
	render: ({ snapshot, context }) => {
		const status = getStatusLineState(snapshot, MCP_STATUS);
		const content = mcpContent(status);
		if (content === undefined) return Option.none();
		return Option.some({
			full: context.theme.fg(content.color, content.full),
			compact: context.theme.fg(content.color, content.compact),
		});
	},
};

/** MCP feature: harvests suppressed footer data and renders MCP adapter status. */
export const mcpFeature: StatusLineFeature = {
	id: "mcp",
	segments: [mcpSegment],
	onFooterData: (data) => updateMcpStatus(data),
};

/** Update MCP status from pi footer data. */
export const updateMcpStatus = (
	data: ReadonlyFooterDataProvider | undefined,
): Effect.Effect<void, never, StatusLineStateStore> =>
	StatusLineStateStore.use((store) =>
		store.set(MCP_STATUS, parseMcpStatusFromFooterData(data)).pipe(Effect.asVoid),
	);

/** Parse MCP status from pi footer data. */
export function parseMcpStatusFromFooterData(
	data: ReadonlyFooterDataProvider | undefined,
): McpStatus {
	const raw = data?.getExtensionStatuses().get("mcp");
	return parseMcpStatusText(raw);
}

/** Parse MCP status text harvested from footer extension statuses. */
export function parseMcpStatusText(raw: string | undefined): McpStatus {
	const text = raw ? stripAnsi(raw).trim() : "";
	if (!text) return McpStatus.Unavailable();

	const counts = /^MCP:\s*(\d+)\/(\d+)\s+servers\b/.exec(text);
	if (counts) {
		const connectedText = counts[1];
		const totalText = counts[2];
		if (connectedText === undefined || totalText === undefined) return McpStatus.Other({ text });
		const connected = Number(connectedText);
		const total = Number(totalText);
		return connected === total
			? McpStatus.Connected({ connected, total })
			: McpStatus.Partial({ connected, total });
	}

	return text.toLowerCase().includes("connecting")
		? McpStatus.Connecting({ text })
		: McpStatus.Other({ text });
}

type McpSegmentContent = {
	readonly full: string;
	readonly compact: string;
	readonly color: ThemeColor;
};

const mcpContent = (status: McpStatus): McpSegmentContent | undefined =>
	McpStatus.$match(status, {
		Unknown: () => undefined,
		Unavailable: () => undefined,
		Connected: (connected) =>
			makeMcpSegmentContent(
				`MCP: ${connected.connected}/${connected.total}`,
				`MCP ${connected.connected}/${connected.total}`,
				"success",
			),
		Partial: (partial) =>
			makeMcpSegmentContent(
				`MCP: ${partial.connected}/${partial.total}`,
				`MCP ${partial.connected}/${partial.total}`,
				partial.connected > 0 ? "warning" : "dim",
			),
		Connecting: (connecting) => makeMcpSegmentContent(connecting.text, "MCP…", "warning"),
		Other: (other) => makeMcpSegmentContent(other.text, "MCP", "accent"),
	});

const makeMcpSegmentContent = (
	full: string,
	compact: string,
	color: ThemeColor,
): McpSegmentContent => ({ full, compact, color });
