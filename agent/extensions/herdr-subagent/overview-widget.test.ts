import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OverviewTheme } from "./overview";
import { registerOverviewWidget, type OverviewWidgetOptions } from "./overview-widget";
import {
	cleanupHarness,
	installFakeHerdr,
	makeTempRoot,
	runHerdrSubagentEffect,
	setEnv,
} from "./test-harness";
import type { RegistryEntry } from "./types";

const WIDGET_ID = "herdr-subagents";
const POLL_MS = 50;
const IDLE_POLL_MS = 100;

type SessionEvent = "session_start" | "session_shutdown";
type WidgetLines = ReadonlyArray<string> | undefined;
type WidgetComponent = { render(width: number): string[]; invalidate(): void };
type WidgetFactory = (tui: unknown, theme: OverviewTheme) => WidgetComponent;
type WidgetContent = ReadonlyArray<string> | WidgetFactory | undefined;
type WidgetCall = { readonly id: string; readonly lines: WidgetLines };
type NotifyCall = { readonly message: string; readonly level: string };

/** Pass-through theme so the fake widget captures plain, uncolored layout lines. */
const plainTheme: OverviewTheme = {
	fg: (_role, text) => text,
	bold: (text) => text,
};

/** Resolve either a plain line array or a component factory into rendered lines. */
const resolveWidget = (content: WidgetContent): WidgetLines =>
	typeof content === "function" ? content({}, plainTheme).render(80) : content;

type FakeWidgetContext = {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly mode: "tui" | "print";
	readonly ui: {
		readonly setWidget: (id: string, content: WidgetContent) => void;
		readonly notify: (message: string, level: string) => void;
		readonly confirm: (title: string, message: string) => Promise<boolean>;
	};
};

type SessionHandler = (event: unknown, ctx: FakeWidgetContext) => void;

type FakeWidgetPi = {
	readonly pi: ExtensionAPI;
	readonly widgetCalls: WidgetCall[];
	readonly notifyCalls: NotifyCall[];
	dispatch(event: SessionEvent, ctx: FakeWidgetContext): void;
};

let activePi: FakeWidgetPi | undefined;

afterEach(async () => {
	activePi?.dispatch("session_shutdown", makeContext("/workspace"));
	activePi = undefined;
	await cleanupHarness();
});

const makeFakePi = (): FakeWidgetPi => {
	const handlers = new Map<SessionEvent, SessionHandler[]>();
	const widgetCalls: WidgetCall[] = [];
	const notifyCalls: NotifyCall[] = [];
	const pi = {
		registerTool() {},
		on(event: SessionEvent, handler: SessionHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		widgetCalls,
		notifyCalls,
		dispatch(event, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				handler({}, ctx);
			}
		},
	};
};

const makeContext = (
	cwd: string,
	overrides: Partial<Pick<FakeWidgetContext, "hasUI" | "mode">> = {},
): FakeWidgetContext => {
	const widgetCalls = activePi?.widgetCalls;
	const notifyCalls = activePi?.notifyCalls;
	return {
		cwd,
		hasUI: overrides.hasUI ?? true,
		mode: overrides.mode ?? "tui",
		ui: {
			setWidget(id, content) {
				widgetCalls?.push({ id, lines: resolveWidget(content) });
			},
			notify(message, level) {
				notifyCalls?.push({ message, level });
			},
			confirm: async () => true,
		},
	};
};

const registerTestWidget = (pi: FakeWidgetPi, options: OverviewWidgetOptions = {}): void => {
	registerOverviewWidget(pi.pi, runHerdrSubagentEffect, {
		pollMs: POLL_MS,
		idlePollMs: IDLE_POLL_MS,
		...options,
	});
};

const sleep = async (millis: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, millis);
	});
};

const startHarness = async (): Promise<{ readonly root: string; readonly agentDir: string }> => {
	const root = await makeTempRoot();
	const agentDir = path.join(root, "agent");
	await installFakeHerdr(root);
	setEnv("HERDR_ENV", "1");
	setEnv("HERDR_SUBAGENT_NAME", undefined);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	return { root, agentDir };
};

interface WriteEntryOptions {
	readonly includeOwner?: boolean;
}

const writeEntry = async (
	agentDir: string,
	overrides: Partial<RegistryEntry> & { readonly name: string },
	options: WriteEntryOptions = {},
): Promise<void> => {
	const registryDir = path.join(agentDir, "herdr-subagents", "registry");
	await mkdir(registryDir, { recursive: true });
	const now = "2026-01-01T00:00:00.000Z";
	const { ownerPaneId: overrideOwnerPaneId, ...entryOverrides } = overrides;
	const ownerPaneId =
		options.includeOwner === false ? undefined : (overrideOwnerPaneId ?? "wTest:p0");
	const ownerFields = ownerPaneId ? { ownerPaneId } : {};
	const entry: RegistryEntry = {
		phase: "active",
		...ownerFields,
		cwd: "/workspace",
		label: `agent: ${overrides.name}`,
		taskFile: `/tmp/${overrides.name}.md`,
		createdAt: now,
		updatedAt: now,
		...entryOverrides,
	};
	await writeFile(
		path.join(registryDir, `${overrides.name}.json`),
		`${JSON.stringify(entry)}\n`,
		"utf8",
	);
};

const lastWidgetLines = (calls: ReadonlyArray<WidgetCall>): WidgetLines => calls.at(-1)?.lines;

const expectRenderedLine = async (pi: FakeWidgetPi, text: string): Promise<void> => {
	await vi.waitFor(
		() => {
			expect(pi.widgetCalls.some((call) => call.lines?.some((line) => line.includes(text)))).toBe(
				true,
			);
		},
		{ timeout: 1_000, interval: 10 },
	);
};

describe("herdr subagent overview widget poller", () => {
	test("does not schedule inside a herdr subagent session", async () => {
		await startHarness();
		setEnv("HERDR_SUBAGENT_NAME", "worker-a");
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));
		await sleep(POLL_MS * 3 + 30);

		expect(pi.widgetCalls).toEqual([]);
	});

	test("does not schedule without an interactive UI", async () => {
		await startHarness();
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace", { mode: "print" }));
		await sleep(POLL_MS * 3 + 30);

		expect(pi.widgetCalls).toEqual([]);
	});

	test("renders active registry entries matched to fake herdr agents", async () => {
		const { agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "worker-a", terminalId: "term-subagent" });
		setEnv("FAKE_HERDR_AGENT_LIST_ENABLE", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));

		await vi.waitFor(
			() => {
				const lines = lastWidgetLines(pi.widgetCalls);
				expect(lines?.[0]).toContain("subagents");
				expect(lines?.[0]).toContain("● 1");
				expect(lines?.some((line) => line.includes("● worker-a"))).toBe(true);
			},
			{ timeout: 1_000, interval: 10 },
		);
	});

	test("shows only registry entries owned by the current session pane", async () => {
		const { agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "owned-a" });
		await writeEntry(agentDir, { name: "foreign-a", ownerPaneId: "wOther:p0" });
		await writeEntry(agentDir, { name: "legacy-a" }, { includeOwner: false });
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));

		await vi.waitFor(
			() => {
				const lines = lastWidgetLines(pi.widgetCalls);
				expect(lines?.some((line) => line.includes("owned-a"))).toBe(true);
				expect(lines?.some((line) => line.includes("foreign-a"))).toBe(false);
				expect(lines?.some((line) => line.includes("legacy-a"))).toBe(false);
			},
			{ timeout: 1_000, interval: 10 },
		);
	});

	test("falls back to showing all entries when the current session pane cannot be resolved", async () => {
		const { agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "owned-a" });
		await writeEntry(agentDir, { name: "foreign-a", ownerPaneId: "wOther:p0" });
		await writeEntry(agentDir, { name: "legacy-a" }, { includeOwner: false });
		setEnv("FAKE_HERDR_PANE_CURRENT_FAIL", "1");
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));

		await vi.waitFor(
			() => {
				const lines = lastWidgetLines(pi.widgetCalls);
				expect(lines?.some((line) => line.includes("owned-a"))).toBe(true);
				expect(lines?.some((line) => line.includes("foreign-a"))).toBe(true);
				expect(lines?.some((line) => line.includes("legacy-a"))).toBe(true);
			},
			{ timeout: 1_000, interval: 10 },
		);
	});

	test("clears the widget when no registry entries exist", async () => {
		await startHarness();
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));

		await vi.waitFor(
			() => {
				expect(pi.widgetCalls.length).toBeGreaterThan(0);
			},
			{ timeout: 1_000, interval: 10 },
		);
		expect(pi.widgetCalls[0]).toEqual({ id: WIDGET_ID, lines: undefined });
	});

	test("notifies once per blocked transition", async () => {
		const { root, agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "review-a", terminalId: "term-subagent" });
		const statusSequence = path.join(root, "status-sequence.txt");
		await writeFile(statusSequence, "blocked\nblocked\nblocked\n", "utf8");
		setEnv("FAKE_HERDR_AGENT_LIST_ENABLE", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "blocked");
		setEnv("FAKE_HERDR_AGENT_STATUS_SEQUENCE_FILE", statusSequence);
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));

		await vi.waitFor(
			() => {
				expect(pi.notifyCalls).toEqual([
					{ message: "subagent review-a is blocked", level: "warning" },
				]);
			},
			{ timeout: 1_000, interval: 10 },
		);
		await sleep(POLL_MS * 3 + 40);
		expect(pi.notifyCalls).toHaveLength(1);

		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		await writeFile(statusSequence, "working\nworking\n", "utf8");
		await expectRenderedLine(pi, "● review-a");

		setEnv("FAKE_HERDR_AGENT_STATUS", "blocked");
		await writeFile(statusSequence, "blocked\nblocked\n", "utf8");
		await vi.waitFor(
			() => {
				expect(pi.notifyCalls).toHaveLength(2);
			},
			{ timeout: 1_000, interval: 10 },
		);
		expect(pi.notifyCalls).toEqual([
			{ message: "subagent review-a is blocked", level: "warning" },
			{ message: "subagent review-a is blocked", level: "warning" },
		]);
	});

	test("clears and stops polling on session shutdown", async () => {
		const { agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "worker-a", terminalId: "term-subagent" });
		setEnv("FAKE_HERDR_AGENT_LIST_ENABLE", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));
		await expectRenderedLine(pi, "worker-a");

		pi.dispatch("session_shutdown", makeContext("/workspace"));
		const callCountAfterShutdown = pi.widgetCalls.length;
		expect(pi.widgetCalls.at(-1)).toEqual({ id: WIDGET_ID, lines: undefined });
		await sleep(POLL_MS * 3 + 40);

		expect(pi.widgetCalls).toHaveLength(callCountAfterShutdown);
	});

	test("keeps polling after transient herdr agent-list failures", async () => {
		const { agentDir } = await startHarness();
		await writeEntry(agentDir, { name: "worker-a", terminalId: "term-subagent" });
		setEnv("FAKE_HERDR_AGENT_LIST_ENABLE", "1");
		setEnv("FAKE_HERDR_AGENT_STATUS", "working");
		const pi = makeFakePi();
		activePi = pi;
		registerTestWidget(pi);

		pi.dispatch("session_start", makeContext("/workspace"));
		await expectRenderedLine(pi, "● worker-a");
		const renderedBeforeFailure = lastWidgetLines(pi.widgetCalls);

		setEnv("FAKE_HERDR_AGENT_LIST_FAIL", "1");
		await sleep(POLL_MS + IDLE_POLL_MS + 60);
		expect(lastWidgetLines(pi.widgetCalls)).toBe(renderedBeforeFailure);

		setEnv("FAKE_HERDR_AGENT_LIST_FAIL", undefined);
		setEnv("FAKE_HERDR_AGENT_STATUS", "idle");
		await expectRenderedLine(pi, "○ worker-a");
	});
});
