import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

import contextExtension from "../agent/extensions/context";

type CapturedCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

// SAFETY: The context overlay only reads `fg` and `bold` from Theme in this test.
const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

function registerContextCommand(): CapturedCommand {
	let captured: CapturedCommand | undefined;
	// SAFETY: Registering the context extension only requires this subset of ExtensionAPI.
	const pi = {
		registerCommand(name: string, command: CapturedCommand) {
			if (name === "context") captured = command;
		},
		getThinkingLevel: () => "high",
		getActiveTools: () => ["read", "bash"],
	} as unknown as ExtensionAPI;

	contextExtension(pi);
	if (captured === undefined) throw new Error("context command was not registered");
	return captured;
}

async function renderContextOverlay(args: string): Promise<Component> {
	let component: Component | undefined;
	const custom = vi.fn(async (factory: unknown) => {
		if (typeof factory !== "function") throw new Error("expected custom factory");
		component = await factory(
			{ terminal: { rows: 24 }, requestRender: () => {} },
			theme,
			{},
			() => {},
		);
		return undefined;
	});

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			custom,
			notify: vi.fn(),
		},
		model: { provider: "test", id: "model" },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
		getSystemPrompt: () => "System prompt\n\tIndented system line",
		getSystemPromptOptions: () => ({
			cwd: "/tmp/project",
			selectedTools: ["read", "bash"],
			contextFiles: [
				{
					path: "/tmp/project/AGENTS.md",
					content: [
						"# Context",
						"",
						"```ts",
						"\tconst value = 1;",
						"\t\treturn value;",
						"```",
					].join("\n"),
				},
			],
			skills: [],
			toolSnippets: {},
			promptGuidelines: [],
		}),
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getBranch: () => [],
		},
	};

	const command = registerContextCommand();
	// SAFETY: The context command only reads the subset of ExtensionCommandContext
	// provided by this focused test double.
	await command.handler(args, ctx as unknown as ExtensionCommandContext);
	if (component === undefined) throw new Error("context overlay was not rendered");
	return component;
}

function widthWithExpandedTabs(line: string): number {
	return visibleWidth(line.replace(/\t/g, "        "));
}

describe("context extension", () => {
	test("scrolling tabbed context never emits terminal tabs or over-wide rows", async () => {
		const component = await renderContextOverlay("files");
		const width = 60;

		for (let i = 0; i < 80; i++) {
			const lines = component.render(width);
			expect(lines.length).toBeLessThanOrEqual(21);
			for (const line of lines) {
				expect(line).not.toContain("\t");
				expect(widthWithExpandedTabs(line)).toBeLessThanOrEqual(width);
			}
			component.handleInput?.("down");
		}
	});
});
