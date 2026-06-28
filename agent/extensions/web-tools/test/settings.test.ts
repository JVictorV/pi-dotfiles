import { test } from "vitest";
import assert from "node:assert/strict";
import {
	parseEnumSetting,
	parseIntegerSetting,
	parseOnOff,
	resolveSearchEndpoint,
} from "../settings.ts";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(vars)) {
		previous.set(key, process.env[key]);
		const value = vars[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("parseOnOff accepts on/off and falls back safely", () => {
	assert.equal(parseOnOff("on", false), true);
	assert.equal(parseOnOff("off", true), false);
	assert.equal(parseOnOff("bogus", true), true);
	assert.equal(parseOnOff(undefined, false), false);
});

test("parseIntegerSetting validates integer ranges", () => {
	assert.equal(parseIntegerSetting("30", 10, { min: 1, max: 120 }), 30);
	assert.equal(parseIntegerSetting("0", 10, { min: 1, max: 120 }), 10);
	assert.equal(parseIntegerSetting("121", 10, { min: 1, max: 120 }), 10);
	assert.equal(parseIntegerSetting("not-a-number", 10, { min: 1, max: 120 }), 10);
});

test("parseEnumSetting validates allowed values", () => {
	assert.equal(parseEnumSetting("markdown", ["markdown", "text", "html"], "text"), "markdown");
	assert.equal(parseEnumSetting("pdf", ["markdown", "text", "html"], "text"), "text");
	assert.equal(parseEnumSetting(undefined, ["markdown", "text", "html"], "text"), "text");
});

test("resolveSearchEndpoint leaves the endpoint unchanged without an API key", () => {
	withEnv({ WEB_TOOLS_EXA_API_KEY: undefined, EXA_API_KEY: undefined }, () => {
		assert.equal(resolveSearchEndpoint("https://mcp.exa.ai/mcp"), "https://mcp.exa.ai/mcp");
	});
});

test("resolveSearchEndpoint injects the API key from the environment", () => {
	withEnv({ WEB_TOOLS_EXA_API_KEY: undefined, EXA_API_KEY: "secret-key" }, () => {
		assert.equal(resolveSearchEndpoint("https://mcp.exa.ai/mcp"), "https://mcp.exa.ai/mcp?exaApiKey=secret-key");
	});
});

test("resolveSearchEndpoint prefers WEB_TOOLS_EXA_API_KEY and respects an existing key", () => {
	withEnv({ WEB_TOOLS_EXA_API_KEY: "preferred", EXA_API_KEY: "fallback" }, () => {
		assert.equal(resolveSearchEndpoint("https://mcp.exa.ai/mcp"), "https://mcp.exa.ai/mcp?exaApiKey=preferred");
		assert.equal(resolveSearchEndpoint("https://mcp.exa.ai/mcp?exaApiKey=existing"), "https://mcp.exa.ai/mcp?exaApiKey=existing");
	});
});
