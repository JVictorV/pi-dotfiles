import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import lspExtension from "../agent/extensions/lsp";
import { loadLspConfig } from "../agent/extensions/lsp/config";
import { LspPermissionStore } from "../agent/extensions/lsp/permissions";
import { LspRuntime } from "../agent/extensions/lsp/runtime";
import { registerLspTool } from "../agent/extensions/lsp/tool";
import type { LspConfig } from "../agent/extensions/lsp/types";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fakeServerPath = join(fixtureDir, "fixtures", "fake-lsp-server.mjs");
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

interface CapturedCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

const createConfig = (
	env?: Record<string, string>,
	extensions: ReadonlyArray<string> = [".fake"],
): LspConfig => ({
	servers: {
		fake: {
			command: ["node", fakeServerPath],
			env,
			extensions,
			rootMarkers: ["project.marker"],
			capabilities: { navigation: true, diagnostics: true },
		},
	},
});

const createProject = async (
	config = createConfig(),
	fileName = "main.fake",
): Promise<TestProject> => {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const cwd = join(root, "project");
	await writeFile(join(cwd, "project.marker"), "", { flag: "w" }).catch(async () => {
		await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd, { recursive: true }));
		await writeFile(join(cwd, "project.marker"), "", { flag: "w" });
	});
	const filePath = join(cwd, fileName);
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
		runtime: new LspRuntime({ cwd, config }),
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

const firstClientProcess = (runtime: LspRuntime): ChildProcessWithoutNullStreams => {
	const clients = (
		runtime as unknown as {
			clients: Map<string, { handle: { process: ChildProcessWithoutNullStreams } }>;
		}
	).clients;
	const next = clients.values().next();
	if (next.done === true) throw new Error("expected an LSP client to be running");
	return next.value.handle.process;
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

	test("concurrent LSP requests share one spawn permission decision", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const [first, second] = await Promise.all([
			tool.execute(
				"tool-call-concurrent-1",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
			tool.execute(
				"tool-call-concurrent-2",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		]);

		expect(first.content[0]?.text).toContain("hover for file://");
		expect(second.content[0]?.text).toContain("hover for file://");
		expect(project.confirm).toHaveBeenCalledOnce();
		expect(project.runtime.status()).toHaveLength(1);
	});

	test("document open uses language ids for common file types", async () => {
		const project = await createProject(
			createConfig({ FAKE_LSP_REPORT_LANGUAGE_ID: "1" }, [".vue"]),
			"main.vue",
		);
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-language-id",
			{ operation: "hover", filePath: "main.vue", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("language=vue");
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
		expect(result.details).toMatchObject({
			operation: "definition",
			results: [{ file: project.filePath, line: 2, character: 3 }],
		});
		expect(JSON.stringify(result.details)).not.toContain("range");
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

	test("diagnostics operation waits for fresh pushed diagnostics", async () => {
		const project = await createProject(
			createConfig({
				FAKE_LSP_NO_PULL_DIAGNOSTICS: "1",
				FAKE_LSP_PUBLISH_DIAGNOSTICS_DELAY_MS: "400",
			}),
		);
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-fresh-diagnostics",
			{ operation: "diagnostics", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("Diagnostics:");
		expect(result.content[0]?.text).toContain("main.fake:1:1 [error] fake diagnostic");
	});

	test("diagnostics operation supports document pull diagnostics", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_PULL_DIAGNOSTICS_ONLY: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-pull-diagnostics",
			{ operation: "diagnostics", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("Diagnostics:");
		expect(result.content[0]?.text).toContain("main.fake:1:1 [error] fake pull diagnostic");
	});

	test("diagnostics operation supports dynamic document diagnostic registration", async () => {
		const project = await createProject(
			createConfig({
				FAKE_LSP_DYNAMIC_DOCUMENT_DIAGNOSTICS: "1",
				FAKE_LSP_PULL_DIAGNOSTICS_ONLY: "1",
			}),
		);
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-dynamic-diagnostics",
			{ operation: "diagnostics", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("Diagnostics:");
		expect(result.content[0]?.text).toContain(
			"main.fake:1:1 [error] fake dynamic document diagnostic",
		);
	});

	test("diagnostics operation supports workspace pull diagnostics", async () => {
		const project = await createProject(
			createConfig({
				FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1",
				FAKE_LSP_PULL_DIAGNOSTICS_ONLY: "1",
			}),
		);
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const result = await tool.execute(
			"tool-call-workspace-diagnostics",
			{ operation: "diagnostics", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("Diagnostics:");
		expect(result.content[0]?.text).toContain("main.fake:1:1 [error] fake workspace diagnostic");
	});

	test("remaining navigation operations return formatted results and honor limits", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const references = await tool.execute(
			"tool-call-references",
			{ operation: "references", filePath: "main.fake", line: 1, character: 1, limit: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(references.content[0]?.text).toContain("references:");
		expect(references.content[0]?.text).toContain("1 more omitted by limit");

		const implementation = await tool.execute(
			"tool-call-implementation",
			{ operation: "implementation", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(implementation.content[0]?.text).toContain("main.fake:4:2");

		const documentSymbol = await tool.execute(
			"tool-call-document-symbol",
			{ operation: "documentSymbol", filePath: "main.fake" },
			undefined,
			undefined,
			project.ctx,
		);
		expect(documentSymbol.content[0]?.text).toContain("fakeSymbol");

		const workspaceSymbol = await tool.execute(
			"tool-call-workspace-symbol",
			{ operation: "workspaceSymbol", filePath: "main.fake", query: "fake" },
			undefined,
			undefined,
			project.ctx,
		);
		expect(workspaceSymbol.content[0]?.text).toContain("workspaceFakeSymbol");

		const incomingCalls = await tool.execute(
			"tool-call-incoming-calls",
			{ operation: "incomingCalls", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(incomingCalls.content[0]?.text).toContain("incomingCaller");

		const outgoingCalls = await tool.execute(
			"tool-call-outgoing-calls",
			{ operation: "outgoingCalls", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(outgoingCalls.content[0]?.text).toContain("outgoingCallee");
	});

	test("extension registers LSP slash commands and emits status", async () => {
		const project = await createProject();
		const commands = new Map<string, CapturedCommand>();
		const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const emitted: Array<{ name: string; data: unknown }> = [];
		const notify = vi.fn();
		const ctx = {
			...project.ctx,
			ui: { ...project.ctx.ui, notify },
		} as unknown as ExtensionContext;
		const pi = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
				listeners.set(name, handler);
			},
			registerCommand(name: string, command: CapturedCommand) {
				commands.set(name, command);
			},
			registerTool() {},
			events: {
				emit(name: string, data: unknown) {
					emitted.push({ name, data });
				},
			},
		} as unknown as ExtensionAPI;

		lspExtension(pi);
		await listeners.get("session_start")?.({}, ctx);

		expect([...commands.keys()].sort()).toEqual([
			"lsp-allow",
			"lsp-deny",
			"lsp-permissions",
			"lsp-reset",
			"lsp-restart",
			"lsp-status",
		]);
		expect(emitted).toContainEqual({ name: "lsp:status", data: { running: [], broken: [] } });

		await commands.get("lsp-status")?.handler("", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No LSP clients running"), "info");

		await listeners.get("session_shutdown")?.({}, ctx);
	});

	test("runtime notifies when LSP client status changes", async () => {
		const project = await createProject();
		const onStatusChange = vi.fn();
		const runtime = new LspRuntime({
			cwd: project.cwd,
			config: createConfig(),
			onStatusChange,
		});
		runtimes.push(runtime);
		const tool = registerTool(runtime);

		await tool.execute(
			"tool-call-status-change",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(onStatusChange).toHaveBeenCalled();
		expect(runtime.status()).toMatchObject([{ serverId: "fake", status: "connected" }]);
	});

	test("touchRunningFile syncs changed file contents into an existing LSP client", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await tool.execute(
			"tool-call-sync-1",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		await writeFile(project.filePath, "changedSymbol()\n", "utf8");
		await project.runtime.touchRunningFile("main.fake");

		const result = await tool.execute(
			"tool-call-sync-2",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("text=changedSymbol()");
	});

	test("document sync sends watched-file create and change notifications", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_REPORT_WATCHED: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const opened = await tool.execute(
			"tool-call-watch-1",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(opened.content[0]?.text).toContain("watched=1");

		await writeFile(project.filePath, "watchedSymbol()\n", "utf8");
		await project.runtime.touchRunningFile("main.fake");

		const changed = await tool.execute(
			"tool-call-watch-2",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(changed.content[0]?.text).toContain("watched=2");
	});

	test("document sync honors incremental text document sync mode", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_REQUIRE_INCREMENTAL_CHANGE: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await tool.execute(
			"tool-call-incremental-1",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		await writeFile(project.filePath, "incrementalSymbol()\n", "utf8");
		await project.runtime.touchRunningFile("main.fake");

		const changed = await tool.execute(
			"tool-call-incremental-2",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(changed.content[0]?.text).toContain("text=incrementalSymbol()");
		expect(changed.content[0]?.text).not.toContain("missing incremental range");
	});

	test("malformed location responses fail visibly", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_MALFORMED_DEFINITION: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await expect(
			tool.execute(
				"tool-call-malformed",
				{ operation: "definition", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({
			_tag: "LspMalformedResponse",
			reason: "definition returned malformed locations",
		});
	});

	test("unsupported server capabilities fail before issuing requests", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_NO_DEFINITION: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await expect(
			tool.execute(
				"tool-call-unsupported",
				{ operation: "definition", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({
			_tag: "LspUnsupportedOperation",
			reason: "definition is not supported by available LSP clients.",
		});
	});

	test("request errors do not mark language servers broken", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_HOVER_ERROR_COUNT: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await expect(
			tool.execute(
				"tool-call-request-error-1",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({
			_tag: "LspRequestError",
			reason: expect.stringContaining("fake hover failed"),
		});
		expect(project.runtime.status()).toMatchObject([{ serverId: "fake", status: "connected" }]);

		const result = await tool.execute(
			"tool-call-request-error-2",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);
		expect(result.content[0]?.text).toContain("hover for file://");
	});

	test("initialization failures are reported as typed initialize errors", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_INITIALIZE_ERROR: "1" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await expect(
			tool.execute(
				"tool-call-init-failure",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({
			_tag: "LspInitializeError",
			serverId: "fake",
			reason: expect.stringContaining("fake initialize failed"),
		});
	});

	test("missing LSP binaries are reported as typed binary errors", async () => {
		const project = await createProject(createConfig(undefined, [".fake"]));
		const missingConfig: LspConfig = {
			servers: {
				fake: {
					command: ["definitely-missing-fake-lsp-binary"],
					extensions: [".fake"],
					rootMarkers: ["project.marker"],
					capabilities: { navigation: true, diagnostics: true },
				},
			},
		};
		const runtime = new LspRuntime({ cwd: project.cwd, config: missingConfig });
		runtimes.push(runtime);
		const tool = registerTool(runtime);

		await expect(
			tool.execute(
				"tool-call-missing-binary",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({
			_tag: "LspBinaryMissing",
			serverId: "fake",
		});
	});

	test("denied LSP spawn permissions are reported as typed permission errors", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);
		const noUiCtx = { ...project.ctx, hasUI: false } as unknown as ExtensionContext;

		await expect(
			tool.execute(
				"tool-call-permission-denied",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				noUiCtx,
			),
		).rejects.toMatchObject({
			_tag: "LspPermissionDenied",
			serverId: "fake",
		});
	});

	test("shutdown tolerates language servers that already closed their stdio", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await tool.execute(
			"tool-call-shutdown",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		const child = firstClientProcess(project.runtime);
		child.kill("SIGTERM");
		await once(child, "exit");

		await expect(project.runtime.shutdown()).resolves.toBeUndefined();
	});

	test("shutdown prevents in-flight spawns from installing clients", async () => {
		const project = await createProject(createConfig({ FAKE_LSP_INITIALIZE_DELAY_MS: "100" }));
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		const pending = tool.execute(
			"tool-call-shutdown-inflight",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		await wait(20);
		await expect(project.runtime.shutdown()).resolves.toBeUndefined();
		await expect(pending).rejects.toMatchObject({
			_tag: "LspRuntimeShuttingDown",
			reason: "LSP runtime is shutting down.",
		});
		expect(project.runtime.status()).toEqual([]);
	});

	test("crashed language servers are skipped until restart", async () => {
		const project = await createProject();
		runtimes.push(project.runtime);
		const tool = registerTool(project.runtime);

		await tool.execute(
			"tool-call-crash-1",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		const child = firstClientProcess(project.runtime);
		child.kill("SIGTERM");
		await once(child, "exit");

		await expect(
			tool.execute(
				"tool-call-crash-2",
				{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
				undefined,
				undefined,
				project.ctx,
			),
		).rejects.toMatchObject({ _tag: "LspNoClients" });
		expect(project.runtime.status()).toMatchObject([{ serverId: "fake", status: "broken" }]);
		expect(project.confirm).toHaveBeenCalledOnce();

		await project.runtime.restart("fake");
		const result = await tool.execute(
			"tool-call-crash-3",
			{ operation: "hover", filePath: "main.fake", line: 1, character: 1 },
			undefined,
			undefined,
			project.ctx,
		);

		expect(result.content[0]?.text).toContain("hover for file://");
		expect(project.confirm).toHaveBeenCalledOnce();
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

	test("permission store preserves concurrent writes", async () => {
		const project = await createProject();
		const left = await LspPermissionStore.load();
		const right = await LspPermissionStore.load();

		await Promise.all([
			left.set(project.cwd, "typescript", "allow"),
			right.set(project.cwd, "eslint", "deny"),
		]);

		const stored = await LspPermissionStore.load();
		expect(stored.entries(project.cwd)).toEqual([
			["eslint", "deny"],
			["typescript", "allow"],
		]);
	});

	test("invalid LSP config fails with typed config error", async () => {
		const project = await createProject();
		await mkdir(project.agentDir, { recursive: true });
		await writeFile(join(project.agentDir, "lsp.json"), JSON.stringify({ servers: [] }), "utf8");

		await expect(loadLspConfig()).rejects.toMatchObject({
			_tag: "LspConfigError",
			reason: "agent/lsp.json field servers must be an object",
		});
	});
});
