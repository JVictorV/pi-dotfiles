import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import diffExtension from "../agent/extensions/diff";

type CapturedCommand = {
	readonly description: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

const originalHerdrEnv = process.env.HERDR_ENV;
const originalHerdrPaneId = process.env.HERDR_PANE_ID;
const originalHerdrSocketPath = process.env.HERDR_SOCKET_PATH;
const originalHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

const commandSucceeded = (stdout = ""): ExecResult => ({
	stdout,
	stderr: "",
	code: 0,
	killed: false,
});

const setEnvironmentValue = (name: string, value: string | undefined): void => {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
};

const setHerdrEnvironment = (): void => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "wTest:p1";
	process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
	process.env.HERDR_WORKSPACE_ID = "wTest";
};

afterEach(() => {
	setEnvironmentValue("HERDR_ENV", originalHerdrEnv);
	setEnvironmentValue("HERDR_PANE_ID", originalHerdrPaneId);
	setEnvironmentValue("HERDR_SOCKET_PATH", originalHerdrSocketPath);
	setEnvironmentValue("HERDR_WORKSPACE_ID", originalHerdrWorkspaceId);
});

function registerDiffCommand(exec: ExtensionAPI["exec"]): CapturedCommand {
	let captured: CapturedCommand | undefined;
	// SAFETY: Registering and exercising the diff extension only requires the
	// `registerCommand` and `exec` members supplied by this focused test double.
	const pi = {
		registerCommand(name: string, command: CapturedCommand) {
			if (name === "diff") captured = command;
		},
		exec,
	} as unknown as ExtensionAPI;

	diffExtension(pi);
	if (captured === undefined) throw new Error("diff command was not registered");
	return captured;
}

function makeContext() {
	const notify = vi.fn();
	// SAFETY: The diff command only reads `cwd` and `ui.notify` from this context.
	const ctx = {
		cwd: "/workspace/project",
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	return { ctx, notify };
}

describe("diff extension", () => {
	test("opens Hunk as the pane process so quitting it closes the pane", async () => {
		setHerdrEnvironment();
		const exec = vi
			.fn<ExtensionAPI["exec"]>()
			.mockResolvedValueOnce(
				commandSucceeded(JSON.stringify({ result: { pane: { pane_id: "wTest:p2" } } })),
			)
			.mockResolvedValueOnce(commandSucceeded());
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("", ctx);

		expect(command.description).toBe("Open the working tree diff in Hunk");
		expect(exec).toHaveBeenNthCalledWith(
			1,
			"herdr",
			[
				"pane",
				"split",
				"--pane",
				"wTest:p1",
				"--direction",
				"right",
				"--cwd",
				"/workspace/project",
				"--focus",
			],
			{ cwd: "/workspace/project", timeout: 10_000 },
		);
		expect(exec).toHaveBeenNthCalledWith(
			2,
			"herdr",
			["pane", "run", "wTest:p2", "exec hunk diff"],
			{
				cwd: "/workspace/project",
				timeout: 10_000,
			},
		);
		expect(notify).not.toHaveBeenCalled();
	});

	test("opens Hunk as the root process of a new tab", async () => {
		setHerdrEnvironment();
		const exec = vi
			.fn<ExtensionAPI["exec"]>()
			.mockResolvedValueOnce(
				commandSucceeded(
					JSON.stringify({
						result: {
							root_pane: { pane_id: "wTest:p3" },
							tab: { tab_id: "wTest:t2" },
						},
					}),
				),
			)
			.mockResolvedValueOnce(commandSucceeded());
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("tab", ctx);

		expect(exec).toHaveBeenNthCalledWith(
			1,
			"herdr",
			["tab", "create", "--workspace", "wTest", "--cwd", "/workspace/project", "--focus"],
			{ cwd: "/workspace/project", timeout: 10_000 },
		);
		expect(exec).toHaveBeenNthCalledWith(
			2,
			"herdr",
			["pane", "run", "wTest:p3", "exec hunk diff"],
			{
				cwd: "/workspace/project",
				timeout: 10_000,
			},
		);
		expect(notify).not.toHaveBeenCalled();
	});

	test("reports that Herdr is required without executing commands", async () => {
		setEnvironmentValue("HERDR_ENV", undefined);
		setEnvironmentValue("HERDR_PANE_ID", undefined);
		setEnvironmentValue("HERDR_SOCKET_PATH", undefined);
		setEnvironmentValue("HERDR_WORKSPACE_ID", undefined);
		const exec = vi.fn<ExtensionAPI["exec"]>();
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("", ctx);

		expect(exec).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"/diff requires Pi to be running in a Herdr-managed pane",
			"error",
		);
	});

	test("stops when Herdr cannot create a pane", async () => {
		setHerdrEnvironment();
		const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValueOnce({
			stdout: "",
			stderr: "split failed",
			code: 7,
			killed: false,
		});
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("", ctx);

		expect(exec).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"Creating the Hunk pane exited with code 7: split failed",
			"error",
		);
	});

	test("reports a malformed pane response without attempting to run Hunk", async () => {
		setHerdrEnvironment();
		const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValueOnce(commandSucceeded("not-json"));
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("", ctx);

		expect(exec).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"Herdr returned an invalid response while creating the Hunk pane",
			"error",
		);
	});

	test("closes the new pane when Hunk cannot be started", async () => {
		setHerdrEnvironment();
		const exec = vi
			.fn<ExtensionAPI["exec"]>()
			.mockResolvedValueOnce(
				commandSucceeded(JSON.stringify({ result: { pane: { pane_id: "wTest:p2" } } })),
			)
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "run failed",
				code: 5,
				killed: false,
			})
			.mockResolvedValueOnce(commandSucceeded());
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("", ctx);

		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "close", "wTest:p2"], {
			cwd: "/workspace/project",
			timeout: 10_000,
		});
		expect(notify).toHaveBeenCalledWith("Starting Hunk exited with code 5: run failed", "error");
	});

	test("closes the new tab when Hunk cannot be started", async () => {
		setHerdrEnvironment();
		const exec = vi
			.fn<ExtensionAPI["exec"]>()
			.mockResolvedValueOnce(
				commandSucceeded(
					JSON.stringify({
						result: {
							root_pane: { pane_id: "wTest:p3" },
							tab: { tab_id: "wTest:t2" },
						},
					}),
				),
			)
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "run failed",
				code: 5,
				killed: false,
			})
			.mockResolvedValueOnce(commandSucceeded());
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("tab", ctx);

		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["tab", "close", "wTest:t2"], {
			cwd: "/workspace/project",
			timeout: 10_000,
		});
		expect(notify).toHaveBeenCalledWith("Starting Hunk exited with code 5: run failed", "error");
	});

	test("rejects command arguments", async () => {
		setHerdrEnvironment();
		const exec = vi.fn<ExtensionAPI["exec"]>();
		const command = registerDiffCommand(exec);
		const { ctx, notify } = makeContext();

		await command.handler("--staged", ctx);

		expect(exec).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /diff [tab]", "warning");
	});
});
