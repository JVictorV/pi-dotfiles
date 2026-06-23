// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
import { describe, expect, test } from "vitest";

import { parseMcpStatusText } from ".";
import { McpStatus } from "./state";

describe("MCP status source", () => {
	test("parses connected server counts", () => {
		const status = parseMcpStatusText("MCP: 2/2 servers");

		expect(McpStatus.$is("Connected")(status)).toBe(true);
		if (McpStatus.$is("Connected")(status)) {
			expect(status.connected).toBe(2);
			expect(status.total).toBe(2);
		}
	});

	test("parses partial server counts", () => {
		const status = parseMcpStatusText("MCP: 1/3 servers");

		expect(McpStatus.$is("Partial")(status)).toBe(true);
		if (McpStatus.$is("Partial")(status)) {
			expect(status.connected).toBe(1);
			expect(status.total).toBe(3);
		}
	});

	test("strips ANSI before classification", () => {
		expect(
			McpStatus.$is("Connecting")(parseMcpStatusText("\u001b[33mMCP: connecting\u001b[0m")),
		).toBe(true);
	});
});
