import {
	HerdrInvalidInput,
	HerdrSdk,
	parseAgentName,
	parseHerdrAbsolutePath,
	parsePaneId,
	parseTabId,
	parseWorkspaceId,
	type Agent,
	type Pane,
} from "@herdr/sdk";
import { Config, Duration, Effect, Option, Predicate } from "effect";

import { failTarget } from "./errors";
import type { HerdrAgent, HerdrPane } from "./schemas";
import type { PaneReadSource } from "./types";

// Keep the registry/overview projection stable. SDK schemas own wire decoding;
// these fields are the existing local identity-matching contract, not wire DTOs.
const agentProjection = (agent: Agent): HerdrAgent => ({
	pane_id: agent.paneId,
	terminal_id: agent.terminalId,
	tab_id: agent.tabId,
	workspace_id: agent.workspaceId,
	agent_status: agent.status,
	focused: agent.focused,
	cwd: Option.getOrUndefined(agent.cwd),
	foreground_cwd: Option.getOrUndefined(agent.foregroundCwd),
});

const paneProjection = (pane: Pane): HerdrPane => ({
	pane_id: pane.id,
	terminal_id: pane.terminalId,
	tab_id: pane.tabId,
	workspace_id: pane.workspaceId,
	cwd: Option.getOrUndefined(pane.cwd),
	foreground_cwd: Option.getOrUndefined(pane.foregroundCwd),
});

const inputFailure = (operation: string) => (cause: unknown) =>
	new HerdrInvalidInput(operation, cause);

/** Resolve this process's pane, never the pane currently focused by the user. */
export const currentPane = Effect.fn("Subagents.currentPane")(function* () {
	const herdr = yield* HerdrSdk;
	const callerPaneId = yield* Config.string("HERDR_PANE_ID").pipe(
		Effect.flatMap(parsePaneId),
		Effect.mapError(inputFailure("currentPane: HERDR_PANE_ID is required")),
	);
	return paneProjection(yield* herdr.panes.current({ callerPaneId }));
});

/** List decoded live agents for registry matching and status rendering. */
export const listAgents = Effect.fn("Subagents.listAgents")(function* () {
	const herdr = yield* HerdrSdk;
	return (yield* herdr.agents.list()).map(agentProjection);
});

/** Resolve a native agent target or map a stable terminal id through the live inventory. */
export const liveAgent = Effect.fn("Subagents.liveAgent")(
	function* (target: string) {
		const herdr = yield* HerdrSdk;
		const name = yield* parseAgentName(target).pipe(Effect.mapError(inputFailure("agent.get")));
		const agent = yield* herdr.agents.get({ name }).pipe(
			Effect.catchTag("HerdrServerError", (error) => {
				if (error.serverCode !== "agent_not_found") return Effect.fail(error);
				// Native agent targets exclude terminal ids and pane labels. Registry
				// identity uses the terminal id so it survives pane moves and renumbering.
				return herdr.agents
					.list()
					.pipe(
						Effect.map((agents) => agents.find((candidate) => candidate.terminalId === target)),
					);
			}),
		);
		return agent === undefined ? undefined : agentProjection(agent);
	},
	// Candidate resolution can tolerate unavailable observations, but a protocol
	// mismatch is not a missing target and cannot become valid by polling again.
	Effect.catch((error) =>
		Predicate.isTagged(error, "HerdrUnsupportedProtocol")
			? Effect.fail(error)
			: Effect.succeed(undefined),
	),
);

/** Create the unfocused shell tab used to launch one pi subagent. */
export const createTab = Effect.fn("Subagents.createTab")(function* (input: {
	readonly workspaceId: string;
	readonly cwd: string;
	readonly label: string;
}) {
	const herdr = yield* HerdrSdk;
	const workspaceId = yield* parseWorkspaceId(input.workspaceId).pipe(
		Effect.mapError(inputFailure("tab.create workspace")),
	);
	const cwd = yield* parseHerdrAbsolutePath(input.cwd).pipe(
		Effect.mapError(inputFailure("tab.create cwd")),
	);
	return yield* herdr.tabs.create({ ...input, workspaceId, cwd, focus: false });
});

/** Rename a pane without changing its input or focus. */
export const renamePane = Effect.fn("Subagents.renamePane")(function* (
	target: string,
	label: string,
) {
	const herdr = yield* HerdrSdk;
	const id = yield* parsePaneId(target).pipe(Effect.mapError(inputFailure("pane.rename")));
	yield* herdr.panes.rename(id, label);
});

/** Send text and a real Enter key atomically, including while pi is working. */
export const runInPane = Effect.fn("Subagents.runInPane")(function* (target: string, text: string) {
	const herdr = yield* HerdrSdk;
	const id = yield* parsePaneId(target).pipe(Effect.mapError(inputFailure("pane.sendInput")));
	yield* herdr.panes.sendInput(id, { text, keys: ["Enter"] });
});

/** Read terminal output through the SDK's decoded response. */
export const readPane = Effect.fn("Subagents.readPane")(function* (
	target: string,
	source: PaneReadSource,
	lines: number,
) {
	const herdr = yield* HerdrSdk;
	const id = yield* parsePaneId(target).pipe(Effect.mapError(inputFailure("pane.read")));
	return yield* herdr.panes.read(id, {
		source: source === "recent-unwrapped" ? "recent_unwrapped" : source,
		lines,
	});
});

/** Wait server-side with a local deadline longer than the server wait. */
export const waitForAgentStatus = Effect.fn("Subagents.waitForAgentStatus")(function* (
	target: string,
	status: Agent["status"],
	timeoutMs: number,
) {
	const herdr = yield* HerdrSdk;
	const name = yield* parseAgentName(target).pipe(Effect.mapError(inputFailure("agent.wait")));
	yield* herdr.agents.wait(
		{ name },
		{ until: [status], timeoutMs },
		{ requestTimeout: Duration.millis(timeoutMs + 1_000) },
	);
});

/** Focus the current pane of a native agent target or stable terminal id. */
export const focusAgent = Effect.fn("Subagents.focusAgent")(function* (target: string) {
	const herdr = yield* HerdrSdk;
	const agent = yield* liveAgent(target);
	if (!agent?.pane_id) return yield* failTarget(`Could not resolve agent to focus: ${target}.`);
	const paneId = yield* parsePaneId(agent.pane_id).pipe(
		Effect.mapError(inputFailure("agent.focus")),
	);
	yield* herdr.agents.focus({ paneId });
});

/** Close one known subagent tab. */
export const closeTab = Effect.fn("Subagents.closeTab")(function* (target: string) {
	const herdr = yield* HerdrSdk;
	const id = yield* parseTabId(target).pipe(Effect.mapError(inputFailure("tab.close")));
	yield* herdr.tabs.close(id);
});

/** Check whether a tab still exists after a failed close. */
export const tabExists = Effect.fn("Subagents.tabExists")(
	function* (target: string) {
		const herdr = yield* HerdrSdk;
		const id = yield* parseTabId(target).pipe(Effect.mapError(inputFailure("tab.get")));
		yield* herdr.tabs.get(id);
		return true;
	},
	Effect.catchTag("HerdrServerError", (error) =>
		error.serverCode === "tab_not_found" ? Effect.succeed(false) : Effect.fail(error),
	),
);

/** Close a resolved pane that has no registered tab. */
export const closePane = Effect.fn("Subagents.closePane")(function* (target: string) {
	const herdr = yield* HerdrSdk;
	const id = yield* parsePaneId(target).pipe(Effect.mapError(inputFailure("pane.close")));
	yield* herdr.panes.close(id);
});
