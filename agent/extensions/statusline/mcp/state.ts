import { Data } from "effect";

import { makeStatusLineStateKey } from "../core/state";

/** MCP adapter state harvested from footer extension statuses. */
export type McpStatus = Data.TaggedEnum<{
	Unknown: {};
	Unavailable: {};
	Connected: { readonly connected: number; readonly total: number };
	Partial: { readonly connected: number; readonly total: number };
	Connecting: { readonly text: string };
	Other: { readonly text: string };
}>;

/** Constructors and matchers for {@link McpStatus}. */
export const McpStatus = Data.taggedEnum<McpStatus>();

/** State key for the MCP feature. */
export const MCP_STATUS = makeStatusLineStateKey<McpStatus>({
	id: "mcp",
	initial: McpStatus.Unknown(),
	equals: mcpStatusEquals,
});

/** Compare MCP status states. */
export function mcpStatusEquals(left: McpStatus, right: McpStatus): boolean {
	return McpStatus.$match(left, {
		Unknown: () => McpStatus.$is("Unknown")(right),
		Unavailable: () => McpStatus.$is("Unavailable")(right),
		Connected: (connected) =>
			McpStatus.$is("Connected")(right) &&
			connected.connected === right.connected &&
			connected.total === right.total,
		Partial: (partial) =>
			McpStatus.$is("Partial")(right) &&
			partial.connected === right.connected &&
			partial.total === right.total,
		Connecting: (connecting) =>
			McpStatus.$is("Connecting")(right) && connecting.text === right.text,
		Other: (other) => McpStatus.$is("Other")(right) && other.text === right.text,
	});
}
