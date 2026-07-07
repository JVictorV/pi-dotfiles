import { Clock, Effect, Result } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { buildTaskPrompt, discoverAgents, formatAgentTypes } from "./agents";
import {
	failAction,
	HerdrCommandFailed,
	HerdrNotAvailable,
	type HerdrSubagentError,
	SubagentRecursionDenied,
	HerdrSubagentToolError,
	SpawnRejected,
	toToolError,
	WaitTimedOut,
} from "./errors";
import {
	currentPane,
	decodeHerdrJson,
	isHerdrSubagentSession,
	isHerdrSubagentSpawnAllowed,
	isRunningInsideHerdr,
	liveAgent,
	runHerdr,
	tabExists,
} from "./herdr-cli";
import { resolveModelReference } from "./model-resolver";
import { requireTarget, resolvePane } from "./pane";
import { textContent, truncateForModel } from "./output";
import { casesHandled } from "./prelude";
import {
	entryPhase,
	finalizeEntry,
	findEntry,
	listEntries,
	matchEntriesToAgents,
	nowIso,
	readEntry,
	removeEntry,
	reserveEntry,
	RESERVATION_STALE_MS,
	updateEntryHints,
} from "./store";
import { deleteRuntimeFiles, writeRuntimeFile } from "./runtime-files";
import * as SubagentName from "./subagent-name";
import { decodeAgentListResponse, decodeTabCreateResponse } from "./schemas";
import type {
	AgentDefinition,
	HerdrSubagentAction,
	HerdrSubagentParams,
	PiToolContext,
	RegistryEntry,
	ResolvedPane,
	ToolResult,
} from "./types";

type HerdrActionRequirements = ChildProcessSpawner | FileSystem | Path;

interface HerdrActionEnvironment {
	readonly resultSocketPath?: string;
}

const DEFAULT_INSPECT_LINES = 120;
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const WAIT_POLL_INTERVAL_MS = 2_000;
const WAIT_IDLE_CONFIRMATIONS = 2;

type RecursionGuardedAction = "spawn" | "send" | "close" | "focus";

const RECURSION_GUARDED_ACTIONS: ReadonlyArray<RecursionGuardedAction> = [
	"spawn",
	"send",
	"close",
	"focus",
];

const subagentRecursionDeniedMessage = (action: HerdrSubagentAction): string =>
	`Subagent sessions cannot run herdr_subagent action=${action} by default. Finish your own task and report back to your orchestrator with STATUS: done or STATUS: blocked instead of spawning or directing additional agents. If recursive delegation is genuinely needed, the orchestrator can grant spawn rights with allowSpawn; keep fan-out budgets in mind.`;

const isRecursionGuardedAction = (action: HerdrSubagentAction): action is RecursionGuardedAction =>
	RECURSION_GUARDED_ACTIONS.some((guardedAction) => guardedAction === action);

const guardSubagentRecursion = (
	action: HerdrSubagentAction,
): Effect.Effect<void, SubagentRecursionDenied> => {
	if (
		!isHerdrSubagentSession() ||
		isHerdrSubagentSpawnAllowed() ||
		!isRecursionGuardedAction(action)
	) {
		return Effect.void;
	}
	return Effect.fail(
		new SubagentRecursionDenied({
			action,
			message: subagentRecursionDeniedMessage(action),
		}),
	);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const isRegistryReservation = (entry: RegistryEntry): boolean => entryPhase(entry) === "reserved";

const commandStatus: Effect.Effect<
	ToolResult,
	HerdrCommandFailed | HerdrSubagentError,
	HerdrActionRequirements
> = Effect.gen(function* () {
	const entries = [...(yield* listEntries)];
	const response = yield* decodeHerdrJson(["agent", "list"], decodeAgentListResponse);
	const liveAgents = response.result.agents;
	const seenNames = new Set<string>();
	const rows: string[] = [];

	const replaceEntry = (updated: RegistryEntry): void => {
		const index = entries.findIndex((entry) => entry.name === updated.name);
		if (index >= 0) {
			entries[index] = updated;
		}
	};

	for (const match of matchEntriesToAgents(entries, liveAgents)) {
		const agent = match.agent;
		if (!agent) {
			continue;
		}
		const terminalId = agent.terminal_id;
		const paneId = agent.pane_id;
		const tabId = agent.tab_id;
		const matched = match.entry;
		if (matched && paneId) {
			seenNames.add(matched.name);
			const updated: RegistryEntry = {
				...matched,
				phase: "active",
				target: terminalId ?? paneId,
				terminalId: terminalId ?? matched.terminalId,
				paneId,
				tabId: tabId ?? matched.tabId,
				workspaceId: agent.workspace_id ?? matched.workspaceId,
				updatedAt: yield* nowIso,
			};
			replaceEntry(updated);
			yield* updateEntryHints(updated);
		}
		const name = matched?.name ?? "-";
		const status = agent.agent_status ?? "unknown";
		const focus = agent.focused ? "*" : " ";
		const cwd = agent.foreground_cwd ?? agent.cwd ?? "";
		rows.push(
			`${focus} ${name.padEnd(22)} ${status.padEnd(8)} ${(paneId ?? "").padEnd(12)} ${cwd}`,
		);
	}

	for (const entry of entries) {
		if (!seenNames.has(entry.name) && !isRegistryReservation(entry)) {
			rows.push(
				`  ${entry.name.padEnd(22)} missing  ${(entry.paneId ?? "").padEnd(12)} ${entry.cwd}`,
			);
		}
	}

	const text =
		rows.length > 0
			? `F NAME                   STATUS   PANE         CWD\n${rows.join("\n")}`
			: "No herdr agents found.";
	return {
		content: [textContent(text)],
		details: { action: "status", entries },
	};
});

const commandAgentTypes: (
	params: HerdrSubagentParams,
	ctxCwd: string,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params, ctxCwd) {
		const discovery = yield* discoverAgents(ctxCwd, params.agentScope ?? "user");
		return {
			content: [textContent(formatAgentTypes(discovery))],
			details: {
				action: "agent-types",
				projectAgentsDir: discovery.projectAgentsDir,
				agents: discovery.agents,
			},
		};
	},
);

const confirmProjectAgent = (
	agent: AgentDefinition,
	ctx: PiToolContext,
): Effect.Effect<boolean, SpawnRejected> =>
	Effect.tryPromise({
		try: () =>
			ctx.ui.confirm(
				"Run project-local herdr subagent?",
				`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
			),
		catch: (cause) =>
			new SpawnRejected({
				message: "Could not confirm project-local agent approval.",
				cause,
			}),
	});

const cleanupFailedSpawn: (
	name: string,
	tabId: string | undefined,
	filePaths: ReadonlyArray<string | undefined>,
) => Effect.Effect<void, never, HerdrActionRequirements> = Effect.fnUntraced(
	function* (name, tabId, filePaths) {
		if (tabId) {
			yield* runHerdr(["tab", "close", tabId]).pipe(Effect.catch(() => Effect.void));
		}
		yield* deleteRuntimeFiles(filePaths);
		yield* removeEntry(name).pipe(Effect.catch(() => Effect.void));
	},
);

const commandSpawn: (
	params: HerdrSubagentParams,
	ctx: PiToolContext,
	environment: HerdrActionEnvironment,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params, ctx, environment) {
		const rawName = params.name;
		const task = params.task;
		if (!rawName || !task) {
			return yield* failAction("spawn requires both name and task.");
		}
		const parsedName = SubagentName.parse(rawName);
		if (Result.isFailure(parsedName)) {
			return yield* Effect.fail(parsedName.failure);
		}
		const name = parsedName.success;

		const existing = yield* readEntry(name);
		if (existing) {
			const now = yield* Clock.currentTimeMillis;
			const updatedAt = Date.parse(existing.updatedAt);
			const staleReservation =
				entryPhase(existing) === "reserved" &&
				Number.isFinite(updatedAt) &&
				now - updatedAt > RESERVATION_STALE_MS;
			if (!staleReservation) {
				return yield* failAction(
					`A subagent named ${name} is already registered. Use close first, or pick a different name.`,
				);
			}
		}

		const discovery = yield* discoverAgents(ctx.cwd, params.agentScope ?? "user");
		const agent = params.agentType
			? discovery.agents.find((candidate) => candidate.name === params.agentType)
			: undefined;
		if (params.agentType && !agent) {
			return yield* failAction(
				`Unknown agentType ${params.agentType}.\n\n${formatAgentTypes(discovery)}`,
			);
		}

		if (agent?.source === "project" && (params.confirmProjectAgents ?? true)) {
			if (!ctx.hasUI) {
				return yield* failAction(
					`Project-local agent ${agent.name} requires confirmation, but this pi session has no UI. Pass confirmProjectAgents: false only for trusted repositories.`,
				);
			}
			const ok = yield* confirmProjectAgent(agent, ctx);
			if (!ok) {
				return {
					content: [textContent("Canceled: project-local agent was not approved.")],
					details: { action: "spawn", projectAgentsDir: discovery.projectAgentsDir },
				};
			}
		}

		const requestedModel = params.model ?? agent?.model;
		let model: string | undefined;
		if (requestedModel && ctx.modelRegistry) {
			const resolvedModel = resolveModelReference(requestedModel, ctx.modelRegistry);
			if (Result.isFailure(resolvedModel)) {
				return yield* Effect.fail(resolvedModel.failure);
			}
			model = resolvedModel.success.reference;
		} else {
			model = requestedModel;
		}

		const pane = yield* currentPane().pipe(
			Effect.catch((error) => (params.workspace ? Effect.succeed(undefined) : Effect.fail(error))),
		);
		const workspaceId = params.workspace ?? pane?.workspace_id;
		if (!workspaceId) {
			return yield* failAction("Could not determine herdr workspace. Pass workspace explicitly.");
		}
		const spawnWorkspaceId = workspaceId;
		const cwd = params.cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? ctx.cwd;
		const label = params.label ?? `agent: ${name}`;
		const allowSpawn = params.allowSpawn ?? agent?.allowSpawn ?? false;
		const ownerPaneId = pane?.pane_id;
		const ownerFields = ownerPaneId ? { ownerPaneId } : {};
		const reservedAt = yield* nowIso;
		const reservation: RegistryEntry = {
			name,
			phase: "reserved",
			...ownerFields,
			cwd,
			label,
			agentType: params.agentType,
			model,
			thinking: params.thinking ?? agent?.thinking,
			taskFile: "",
			createdAt: reservedAt,
			updatedAt: reservedAt,
		};
		yield* reserveEntry(reservation);

		const runtimeFiles: Array<string | undefined> = [];
		let createdTabId: string | undefined;
		const spawnAfterReservation: Effect.Effect<
			ToolResult,
			HerdrSubagentError,
			HerdrActionRequirements
		> = Effect.gen(function* () {
			const resultSocketEnv = environment.resultSocketPath
				? ["--env", `HERDR_SUBAGENT_RESULT_SOCK=${environment.resultSocketPath}`]
				: [];
			const createArgs = [
				"tab",
				"create",
				"--workspace",
				spawnWorkspaceId,
				"--cwd",
				cwd,
				"--label",
				label,
				"--env",
				`HERDR_SUBAGENT_NAME=${name}`,
				"--env",
				`HERDR_SUBAGENT_ALLOW_SPAWN=${allowSpawn ? "1" : "0"}`,
				...resultSocketEnv,
				"--no-focus",
			];
			const created = yield* decodeHerdrJson(createArgs, decodeTabCreateResponse);
			const rootPane = created.result.root_pane ?? created.result.pane;
			const tab = created.result.tab;
			const tabId = tab?.tab_id ?? rootPane?.tab_id;
			createdTabId = tabId;
			const paneId = rootPane?.pane_id;
			if (!paneId) {
				return yield* failAction(
					`Could not find root pane in herdr response:\n${JSON.stringify(created, null, 2)}`,
				);
			}
			const terminalId = rootPane?.terminal_id;
			yield* runHerdr(["pane", "rename", paneId, label]).pipe(Effect.catch(() => Effect.void));

			const taskFile = yield* writeRuntimeFile(
				"task",
				name,
				buildTaskPrompt(name, task, params.agentType),
			);
			runtimeFiles.push(taskFile);
			const systemPromptFile = agent?.systemPrompt
				? yield* writeRuntimeFile("system", name, agent.systemPrompt)
				: undefined;
			runtimeFiles.push(systemPromptFile);
			const thinking = params.thinking ?? agent?.thinking;
			const tools = params.tools ?? agent?.tools;
			const commandParts = ["pi", "--name", `subagent: ${name}`];
			if (model) {
				commandParts.push("--model", model);
			}
			if (thinking) {
				commandParts.push("--thinking", thinking);
			}
			if (tools && tools.length > 0) {
				commandParts.push("--tools", tools.join(","));
			}
			if (systemPromptFile) {
				commandParts.push("--append-system-prompt", systemPromptFile);
			}
			commandParts.push(`@${taskFile}`);
			const command = commandParts.map(shellQuote).join(" ");
			yield* runHerdr(["pane", "run", paneId, command]);

			const createdAt = yield* nowIso;
			const updatedAt = yield* nowIso;
			const entry: RegistryEntry = {
				name,
				phase: "active",
				...ownerFields,
				target: terminalId ?? paneId,
				paneId,
				tabId,
				workspaceId: spawnWorkspaceId,
				terminalId,
				cwd,
				label,
				agentType: params.agentType,
				model,
				thinking,
				taskFile,
				systemPromptFile,
				createdAt,
				updatedAt,
			};
			yield* finalizeEntry(entry);

			return {
				content: [
					textContent(
						`Spawned ${name} in herdr panel.\nTarget: ${entry.target}\nPane: ${paneId}\nTab: ${tabId ?? "unknown"}\nWorkspace: ${spawnWorkspaceId}\nCWD: ${cwd}\n\nNext: you will receive a subagent_result follow-up when ${name} finishes or blocks. Do not poll wait or duplicate the work; use wait only when you explicitly need to block.`,
					),
				],
				details: { action: "spawn", entry },
			};
		});

		return yield* spawnAfterReservation.pipe(
			Effect.onError(() => cleanupFailedSpawn(name, createdTabId, runtimeFiles)),
		);
	},
);

const commandInspect: (
	params: HerdrSubagentParams,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params) {
		const target = requireTarget(params);
		if (!target) {
			return yield* failAction("inspect requires target or name.");
		}
		const entries = yield* listEntries;
		const resolved = yield* resolvePane(target, entries);
		const lines = params.lines ?? DEFAULT_INSPECT_LINES;
		const source = params.source ?? "recent-unwrapped";
		const outcome = yield* runHerdr([
			"pane",
			"read",
			resolved.paneId,
			"--source",
			source,
			"--lines",
			String(lines),
		]);
		const truncated = truncateForModel(outcome.stdout, lines);
		return {
			content: [textContent(truncated.text)],
			details: {
				action: "inspect",
				target,
				resolved,
				source,
				lines,
				truncated: truncated.truncated,
			},
		};
	},
);

const commandSend: (
	params: HerdrSubagentParams,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params) {
		const target = requireTarget(params);
		if (!target || !params.message) {
			return yield* failAction("send requires target/name and message.");
		}
		const entries = yield* listEntries;
		const resolved = yield* resolvePane(target, entries);
		yield* runHerdr(["pane", "run", resolved.paneId, params.message]);
		return {
			content: [textContent(`Sent message to ${resolved.name} (${resolved.paneId}).`)],
			details: { action: "send", resolved },
		};
	},
);

/**
 * Wait until a subagent has finished its turn.
 *
 * Herdr's `done` agent status means "finished and not yet viewed": pi only ever
 * reports `working`/`blocked`/`idle`, and herdr synthesizes `done` for an idle
 * pane nobody has looked at. A finished pane that is visible or already viewed
 * reports `idle` directly, so `herdr wait agent-status --status done` can block
 * for the full timeout even though the subagent finished long ago. Poll the
 * agent status instead and accept either `done` or a stable `idle`.
 *
 * `idle` must be observed on {@link WAIT_IDLE_CONFIRMATIONS} consecutive polls
 * because pi publishes a transient `idle` at session start, before the spawned
 * task begins working.
 */
const startupIdleStabilityMs = (timeoutMs: number): number =>
	Math.min(10_000, Math.max(0, Math.floor(timeoutMs * 0.6)));

const waitForFinished: (
	resolved: ResolvedPane,
	timeoutMs: number,
) => Effect.Effect<{ readonly observed: "done" | "idle" }, WaitTimedOut, HerdrActionRequirements> =
	Effect.fnUntraced(function* (resolved, timeoutMs) {
		const startedAt = yield* Clock.currentTimeMillis;
		// Scale the poll interval down for short timeouts so a quick wait can still
		// confirm consecutive idle polls before the deadline.
		const pollMs = Math.max(100, Math.min(WAIT_POLL_INTERVAL_MS, Math.floor(timeoutMs / 5)));
		const neverWorkedIdleMs = startupIdleStabilityMs(timeoutMs);
		let consecutiveIdle = 0;
		let firstIdleAt: number | undefined;
		let observedWorking = false;
		let lastStatus = "unknown";
		const poll: Effect.Effect<
			{ readonly observed: "done" | "idle" },
			WaitTimedOut,
			HerdrActionRequirements
		> = Effect.suspend(() =>
			Effect.gen(function* () {
				const agent = yield* liveAgent(resolved.paneId);
				lastStatus = agent?.agent_status ?? "unknown";
				if (lastStatus === "done") {
					return { observed: "done" };
				}
				if (lastStatus === "working") {
					observedWorking = true;
				}
				if (lastStatus === "idle") {
					const now = yield* Clock.currentTimeMillis;
					firstIdleAt ??= now;
					consecutiveIdle += 1;
					if (observedWorking) {
						if (consecutiveIdle >= WAIT_IDLE_CONFIRMATIONS) {
							return { observed: "idle" };
						}
					} else if (
						consecutiveIdle >= WAIT_IDLE_CONFIRMATIONS &&
						now - firstIdleAt >= neverWorkedIdleMs
					) {
						return { observed: "idle" };
					}
				} else {
					consecutiveIdle = 0;
					firstIdleAt = undefined;
				}
				const now = yield* Clock.currentTimeMillis;
				const elapsed = now - startedAt;
				const remaining = timeoutMs - elapsed;
				if (remaining <= 0) {
					return yield* new WaitTimedOut({
						message: `wait timed out after ${timeoutMs}ms; last agent status: ${lastStatus}. Inspect ${resolved.name} to check progress, then re-wait.`,
					});
				}
				yield* Effect.sleep(Math.min(pollMs, remaining));
				return yield* poll;
			}),
		);
		return yield* poll;
	});

const commandWait: (
	params: HerdrSubagentParams,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params) {
		const target = requireTarget(params);
		if (!target) {
			return yield* failAction("wait requires target or name.");
		}
		const entries = yield* listEntries;
		const resolved = yield* resolvePane(target, entries);
		const status = params.status ?? "done";
		const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (status === "done") {
			const outcome = yield* waitForFinished(resolved, timeoutMs);
			const viaIdle =
				outcome.observed === "idle"
					? " (reported idle: the pane was already viewed or finished before the wait)"
					: "";
			return {
				content: [
					textContent(
						`${resolved.name} finished${viaIdle}. Inspect the panel before trusting the result.`,
					),
				],
				details: { action: "wait", resolved, status, observed: outcome.observed },
			};
		}
		yield* runHerdr(
			["wait", "agent-status", resolved.paneId, "--status", status, "--timeout", String(timeoutMs)],
			timeoutMs + 1_000,
		);
		return {
			content: [
				textContent(
					`${resolved.name} reached ${status}. Inspect the panel before trusting the result.`,
				),
			],
			details: { action: "wait", resolved, status },
		};
	},
);

const commandFocus: (
	params: HerdrSubagentParams,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params) {
		const target = requireTarget(params);
		if (!target) {
			return yield* failAction("focus requires target or name.");
		}
		const namedEntry = yield* readEntry(target);
		const entries = namedEntry ? undefined : yield* listEntries;
		const entry = namedEntry ?? findEntry(entries ?? [], target);
		const focusTarget = entry?.target ?? entry?.terminalId ?? target;
		yield* runHerdr(["agent", "focus", focusTarget]);
		return {
			content: [textContent(`Focused ${target}.`)],
			details: { action: "focus", target: focusTarget },
		};
	},
);

const commandClose: (
	params: HerdrSubagentParams,
) => Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params) {
		const target = requireTarget(params);
		if (!target) {
			return yield* failAction("close requires target or name.");
		}
		const entries = yield* listEntries;
		const entry = findEntry(entries, target);
		if (entry?.tabId) {
			const closeResult = yield* runHerdr(["tab", "close", entry.tabId]).pipe(Effect.result);
			const closeFailure = Result.isFailure(closeResult) ? closeResult.failure : undefined;
			if (closeFailure) {
				// The tab may already be gone (for example, closed manually in herdr's UI).
				// Keeping the entry would block the name forever, so only surface the
				// failure when the tab still exists; otherwise clean up the stale entry.
				if (yield* tabExists(entry.tabId)) {
					return yield* Effect.fail(closeFailure);
				}
				yield* removeEntry(entry.name);
				yield* deleteRuntimeFiles([entry.taskFile, entry.systemPromptFile]);
				return {
					content: [
						textContent(
							`Tab ${entry.tabId} for ${entry.name} was already gone; removed the stale registry entry.`,
						),
					],
					details: { action: "close", entry, stale: true },
				};
			}
			yield* removeEntry(entry.name);
			yield* deleteRuntimeFiles([entry.taskFile, entry.systemPromptFile]);
			return {
				content: [textContent(`Closed tab ${entry.tabId} for ${entry.name}.`)],
				details: { action: "close", entry },
			};
		}
		const resolved = yield* resolvePane(target, entries);
		yield* runHerdr(["pane", "close", resolved.paneId]);
		// A registry entry without a tabId can still reference this pane; clean it up
		// so the closed pane does not leave a permanently "missing" name behind.
		const paneEntry = entry ?? findEntry(entries, resolved.paneId);
		if (paneEntry) {
			yield* removeEntry(paneEntry.name);
			yield* deleteRuntimeFiles([paneEntry.taskFile, paneEntry.systemPromptFile]);
		}
		return {
			content: [textContent(`Closed pane ${resolved.paneId}.`)],
			details: { action: "close", resolved },
		};
	},
);

const runAction = (
	params: HerdrSubagentParams,
	ctx: PiToolContext,
	environment: HerdrActionEnvironment,
): Effect.Effect<ToolResult, HerdrSubagentError, HerdrActionRequirements> => {
	switch (params.action) {
		case "status":
			return commandStatus;
		case "agent-types":
			return commandAgentTypes(params, ctx.cwd);
		case "spawn":
			return commandSpawn(params, ctx, environment);
		case "inspect":
			return commandInspect(params);
		case "send":
			return commandSend(params);
		case "wait":
			return commandWait(params);
		case "focus":
			return commandFocus(params);
		case "close":
			return commandClose(params);
		default:
			return casesHandled(params.action);
	}
};

export const executeAction: (
	params: HerdrSubagentParams,
	ctx: PiToolContext,
	environment?: HerdrActionEnvironment,
) => Effect.Effect<ToolResult, HerdrSubagentToolError, HerdrActionRequirements> = Effect.fnUntraced(
	function* (params, ctx, environment = {}) {
		if (!isRunningInsideHerdr()) {
			return yield* new HerdrNotAvailable({
				message:
					"HERDR_ENV is not 1; herdr_subagent can only inspect or control panels from inside herdr.",
			});
		}
		yield* guardSubagentRecursion(params.action);
		return yield* runAction(params, ctx, environment);
	},
	Effect.mapError(toToolError),
);
