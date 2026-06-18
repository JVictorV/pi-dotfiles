import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LspRuntime } from "../agent/extensions/lsp/runtime";
import { registerLspTool } from "../agent/extensions/lsp/tool";
import type { LspConfig } from "../agent/extensions/lsp/types";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fakeServerPath = join(fixtureDir, "fixtures", "fake-lsp-server.mjs");

interface TestProject {
	cwd: string;
	agentDir: string;
	filePath: string;
	runtime: LspRuntime;
	confirm: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
	ctx: ExtensionContext;
}

interface CapturedTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; details?: unknown }>;
}

const createConfig = (): LspConfig => ({
	servers: {
		fake: {
			command: ["node", fakeServerPath],
			extensions: [".fake"],
			rootMarkers: ["project.marker"],
			capabilities: { navigation: true, diagnostics: true },
		},
	},
});

const createProject = async (): Promise<TestProject> => {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const cwd = join(root, "project");
	await writeFile(join(cwd, "project.marker"), "", { flag: "w" }).catch(async () => {
		await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd, { recursive: true }));
		await writeFile(join(cwd, "project.marker"), "", { flag: "w" });
	});
	const filePath = join(cwd, "main.fake");
	await writeFile(filePath, "fakeSymbol()\n", "utf8");

	const confirm = vi.fn(async () => true);
	const ctx = {
		cwd,
		hasUI: true,
		ui: { confirm },
	} as unknown as ExtensionContext;

	return {
		cwd,
		agentDir,
		filePath,
		runtime: new LspRuntime({ cwd, config: createConfig() }),
		confirm,
		ctx,
	};
};

const registerTool = (runtime: LspRuntime): CapturedTool => {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool(definition: CapturedTool) {
			captured = definition;
		},
	} as unknown as ExtensionAPI;

	registerLspTool(pi, () => runtime);
	if (captured === undefined) throw new Error("lsp tool was not registered");
	return captured;
};

describe("LSP Extension", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const runtimes: LspRuntime[] = [];

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	});

	test("lsp tool returns hover information from a language server", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-1",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("hover for file://");
		expect(result.content[0]?.text).toContain("at 0:0");
		expect(project.confirm).toHaveBeenCalledOnce();
		expect(project.runtime.status()).toMatchObject([{ serverId: "fake", status: "connected" }]);
	});

	test("lsp tool converts language server locations into editor-friendly one-based positions", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-2",
			{ operation: "definition", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("definition:");
		expect(result.content[0]?.text).toContain("main.fake:2:3");
	});

	test("diagnostics operation reports diagnostics published by the language server", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-3",
			{ operation: "diagnostics", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("Diagnostics:");
		expect(result.content[0]?.text).toContain("main.fake:1:1 [error] fake diagnostic");
	});

	test("stored allow permission is reused for the same repository path", async () => {
		const project = await createProject();
		const firstRuntime = project.runtime;
		runtimes.push(firstRuntime);
		await registerTool(firstRuntime).execute(
			"tool-call-4",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(project.confirm).toHaveBeenCalledOnce();
		await firstRuntime.shutdown();

		const secondRuntime = new LspRuntime({ cwd: project.cwd, config: createConfig() });
		runtimes.push(secondRuntime);
		const secondConfirm = vi.fn(async () => {
			throw new Error("permission prompt should not be shown");
		});
		const secondCtx = {
			cwd: project.cwd,
			hasUI: true,
			ui: { confirm: secondConfirm },
		} as unknown as ExtensionContext;

		const result = await registerTool(secondRuntime).execute(
			"tool-call-5",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			secondCtx,
		);

		expect(result.content[0]?.text).toContain("hover for file://");
		expect(secondConfirm).not.toHaveBeenCalled();
	});
});
