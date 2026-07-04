import type { TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

export const textContent = (text: string): TextContent => ({ type: "text", text });

export const truncateForModel = (
	text: string,
	lines = DEFAULT_MAX_LINES,
): { readonly text: string; readonly truncated: boolean } => {
	const truncation = truncateTail(text, {
		maxLines: Math.min(lines, DEFAULT_MAX_LINES),
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}
	return {
		text: `${truncation.content}\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`,
		truncated: true,
	};
};
