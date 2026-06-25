import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import stackExtension from "../agent/extensions/stack";

type StackToolParams = {
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly timeout?: number;
};

type CapturedStackTool = {
	readonly execute: (
		toolCallId: string,
		params: StackToolParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(async () => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}

	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function registerStackTool(): CapturedStackTool {
	let captured: CapturedStackTool | undefined;
	// SAFETY: Registering the stack extension only requires this subset of ExtensionAPI.
	const pi = {
		registerTool(definition: CapturedStackTool) {
			captured = definition;
		},
		on() {},
	} as unknown as ExtensionAPI;

	stackExtension(pi);
	if (captured === undefined) throw new Error("stack tool was not registered");
	return captured;
}

describe("stack extension", () => {
	test("failed stack CLI executions reject with non-empty diagnostic output", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stack-tool-test-"));
		tempDirs.push(root);
		const fakeStackPath = join(root, "stack");
		await writeFile(
			fakeStackPath,
			[
				"#!/bin/sh",
				'echo "USAGE from fake stack"',
				'echo "ERRORS from fake stack: $*" >&2',
				"exit 7",
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(fakeStackPath, 0o755);
		process.env.PATH = `${root}:${originalPath ?? ""}`;

		const tool = registerStackTool();
		// SAFETY: The stack tool only reads `cwd` from ExtensionContext in this test.
		const ctx = { cwd: root } as unknown as ExtensionContext;
		let thrown: unknown;

		try {
			await tool.execute(
				"tool-call-1",
				{ command: "track", args: ["--branch", "child", "--parent", "parent"] },
				undefined,
				undefined,
				ctx,
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		if (!(thrown instanceof Error)) throw new Error("expected stack tool to throw an Error");
		expect(thrown.message).toContain("stack exited with code 7");
		expect(thrown.message).toContain("USAGE from fake stack");
		expect(thrown.message).toContain(
			"ERRORS from fake stack: track --branch child --parent parent",
		);
	});
});
