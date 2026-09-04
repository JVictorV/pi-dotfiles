import { randomUUID } from "node:crypto";

import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Layer, ManagedRuntime } from "effect";

import { executeAction } from "./actions";
import {
	currentPane,
	herdrSubagentName,
	herdrSubagentResultSocket,
	isHerdrSubagentSession,
	isRunningInsideHerdr,
} from "./herdr-cli";
import { createSubagentNotificationManager } from "./notifications";
import { registerOverviewWidget } from "./overview-widget";
import { textContent } from "./output";
import {
	notifySubagentFinished,
	publishResultSocket,
	readPublishedResultSocket,
	readSubagentCompletionArm,
	startSubagentRpcServer,
	subagentRpcSocketPath,
	unpublishResultSocket,
	type SubagentRpcServer,
} from "./subagent-rpc";
import { entryPhase, findEntryForPane, listEntries } from "./store";
import {
	ACTIONS,
	AGENT_SCOPES,
	SOURCES,
	SPAWN_ISOLATIONS,
	SUBAGENT_THINKING_LEVELS,
	WAIT_STATUSES,
	type HerdrSubagentParams,
	type RegistryEntry,
	type ResolvedPane,
	type ToolResult,
} from "./types";

const nodeLayer = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);
// ExtensionAPI exposes session lifecycle hooks but no extension unload/reload teardown; this
// stateless Node layer only allocates per-run Scope resources, so a /reload orphan is GC-reclaimable.
const nodeRuntime = ManagedRuntime.make(nodeLayer);

type ActionDetails =
	| { readonly action: "spawn"; readonly entry: RegistryEntry }
	| { readonly action: "send"; readonly resolved: ResolvedPane }
	| { readonly action: "wait"; readonly resolved: ResolvedPane }
	| { readonly action: "close"; readonly entry?: RegistryEntry; readonly resolved?: ResolvedPane };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isRegistryEntry = (value: unknown): value is RegistryEntry =>
	isRecord(value) &&
	typeof value.name === "string" &&
	typeof value.cwd === "string" &&
	typeof value.label === "string" &&
	typeof value.taskFile === "string" &&
	typeof value.createdAt === "string" &&
	typeof value.updatedAt === "string";

const isResolvedPane = (value: unknown): value is ResolvedPane =>
	isRecord(value) && typeof value.name === "string" && typeof value.paneId === "string";

type TextPart = { readonly type: "text"; readonly text: string };

type AssistantMessageLike = {
	readonly role: "assistant";
	readonly content: ReadonlyArray<unknown>;
};

const isTextPart = (value: unknown): value is TextPart =>
	isRecord(value) && value.type === "text" && typeof value.text === "string";

const isAssistantMessageLike = (value: unknown): value is AssistantMessageLike =>
	isRecord(value) && value.role === "assistant" && Array.isArray(value.content);

const discardPromise = (promise: Promise<unknown>): void => {
	promise.then(
		() => undefined,
		() => undefined,
	);
};

const finalAssistantText = (event: { readonly messages: ReadonlyArray<unknown> }): string => {
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index];
		if (isAssistantMessageLike(message)) {
			return message.content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("");
		}
	}
	return "";
};

const completionStatus = (finalMessage: string): "done" | "blocked" => {
	let status: "done" | "blocked" = "done";
	for (const match of finalMessage.matchAll(/^\s*STATUS:\s*(done|blocked)\s*$/gim)) {
		status = match[1]?.toLowerCase() === "blocked" ? "blocked" : "done";
	}
	return status;
};

const actionDetails = (result: ToolResult): ActionDetails | undefined => {
	const details = result.details;
	if (!isRecord(details) || typeof details.action !== "string") {
		return undefined;
	}
	if (details.action === "spawn" && isRegistryEntry(details.entry)) {
		return { action: "spawn", entry: details.entry };
	}
	if (details.action === "send" && isResolvedPane(details.resolved)) {
		return { action: "send", resolved: details.resolved };
	}
	if (details.action === "wait" && isResolvedPane(details.resolved)) {
		return { action: "wait", resolved: details.resolved };
	}
	if (details.action === "close") {
		return {
			action: "close",
			entry: isRegistryEntry(details.entry) ? details.entry : undefined,
			resolved: isResolvedPane(details.resolved) ? details.resolved : undefined,
		};
	}
	return undefined;
};

/** Register herdr-backed pi subagent orchestration tools. */
export default function herdrSubagentExtension(pi: ExtensionAPI) {
	const notifications = createSubagentNotificationManager(pi, (effect, options) =>
		nodeRuntime.runPromise(effect, options),
	);
	let rpcServer: SubagentRpcServer | undefined;
	let rpcServerStarting = false;
	let resultSocketPath: string | undefined;
	let latestFinalAssistantText: string | undefined;
	let latestCompletionArmId: string | undefined;
	let sendQueue: Promise<void> = Promise.resolve();
	const unavailableResultSocketPath = subagentRpcSocketPath("unavailable");
	const directResultNames = new Set<string>();
	// Orchestrator-side durable wiring. The owner publication lets resumed subagent sessions
	// find this process's result socket after spawn-time env vars died with an earlier run.
	let ownerPaneId: string | undefined;
	// Resumed-subagent identity cache. Only a definitive lookup outcome is cached; a failed
	// `pane current` stays uncached so a later settle can retry once herdr is reachable.
	let registrySelfResolved = false;
	let registrySelfName: string | undefined;
	let registrySelfOwnerPaneId: string | undefined;
	const adoptOrphanedRegistryEntries = async (socketPath: string): Promise<void> => {
		await nodeRuntime
			.runPromise(
				Effect.gen(function* () {
					const pane = yield* currentPane().pipe(Effect.catch(() => Effect.succeed(undefined)));
					const paneId = pane?.pane_id;
					if (!paneId) {
						return;
					}
					ownerPaneId = paneId;
					yield* publishResultSocket(paneId, socketPath);
					// Entries owned by this pane outlived the previous orchestrator process.
					// Seeding them keeps automatic settled-result delivery armed after a reopen.
					const entries = yield* listEntries;
					for (const entry of entries) {
						if (entryPhase(entry) === "active" && entry.ownerPaneId === paneId) {
							directResultNames.add(entry.name);
						}
					}
				}),
			)
			.catch(() => undefined);
	};
	const ensureRegistrySelf = async (): Promise<void> => {
		if (registrySelfResolved || !isRunningInsideHerdr()) {
			return;
		}
		await nodeRuntime
			.runPromise(
				Effect.gen(function* () {
					const pane = yield* currentPane().pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (!pane) {
						return;
					}
					registrySelfResolved = true;
					const match = findEntryForPane(yield* listEntries, pane);
					if (!match) {
						return;
					}
					registrySelfName = match.name;
					registrySelfOwnerPaneId = match.ownerPaneId;
				}),
			)
			.catch(() => undefined);
	};
	const effectiveSubagentName = async (): Promise<string | undefined> => {
		const envName = herdrSubagentName();
		if (envName) {
			return envName;
		}
		await ensureRegistrySelf();
		return registrySelfName;
	};
	const refreshCompletionArm = async (): Promise<void> => {
		const name = await effectiveSubagentName();
		if (!name) {
			return;
		}
		latestCompletionArmId = await Effect.runPromise(readSubagentCompletionArm(name));
	};
	const overviewWidget = registerOverviewWidget(pi, (effect) => nodeRuntime.runPromise(effect));
	if (typeof pi.on === "function") {
		pi.on("session_start", () => {
			if (!isRunningInsideHerdr() || isHerdrSubagentSession() || rpcServer || rpcServerStarting) {
				return;
			}
			rpcServerStarting = true;
			discardPromise(
				nodeRuntime
					.runPromise(
						startSubagentRpcServer({
							onFinished(payload) {
								notifications.deliverExternal(payload.name, {
									status: payload.status,
									finalMessage: payload.finalMessage,
									sentAtMs: payload.sentAtMs,
									completionId: payload.completionId,
									armId: payload.armId,
								});
							},
						}),
					)
					.then(
						async (server) => {
							rpcServerStarting = false;
							rpcServer = server;
							resultSocketPath = server.socketPath;
							await adoptOrphanedRegistryEntries(server.socketPath);
						},
						() => {
							rpcServerStarting = false;
						},
					),
			);
		});
		pi.on("input", refreshCompletionArm);
		pi.on("agent_start", async () => {
			latestFinalAssistantText = undefined;
			await refreshCompletionArm();
		});
		pi.on("agent_end", (event) => {
			const finalMessage = finalAssistantText(event).trim();
			latestFinalAssistantText = finalMessage.length > 0 ? finalMessage : undefined;
		});
		pi.on("agent_settled", async () => {
			const finalMessage = latestFinalAssistantText;
			latestFinalAssistantText = undefined;
			if (!isRunningInsideHerdr() || !finalMessage) {
				return;
			}
			await ensureRegistrySelf();
			const name = herdrSubagentName() ?? registrySelfName;
			if (!name) {
				return;
			}
			// The published socket tracks the live orchestrator process; the spawn-time env var can
			// point at a socket removed by an earlier parent incarnation. With neither, fall back to
			// an unreachable path so the settled result still lands in the durable completion outbox.
			const publishedSocketPath = registrySelfOwnerPaneId
				? await Effect.runPromise(readPublishedResultSocket(registrySelfOwnerPaneId))
				: undefined;
			const socketPath =
				publishedSocketPath ?? herdrSubagentResultSocket() ?? unavailableResultSocketPath;
			if (!latestCompletionArmId) {
				await refreshCompletionArm();
			}
			await Effect.runPromise(
				Effect.gen(function* () {
					const sentAtMs = yield* Clock.currentTimeMillis;
					yield* notifySubagentFinished({
						socketPath,
						name,
						status: completionStatus(finalMessage),
						finalMessage,
						sentAtMs,
						armId: latestCompletionArmId,
					});
				}),
			);
		});
		pi.on("session_shutdown", () => {
			notifications.cancelAll();
			directResultNames.clear();
			latestFinalAssistantText = undefined;
			latestCompletionArmId = undefined;
			registrySelfResolved = false;
			registrySelfName = undefined;
			registrySelfOwnerPaneId = undefined;
			const adoptedOwnerPaneId = ownerPaneId;
			ownerPaneId = undefined;
			const server = rpcServer;
			rpcServer = undefined;
			rpcServerStarting = false;
			resultSocketPath = undefined;
			if (server) {
				discardPromise(server.close());
			}
			if (adoptedOwnerPaneId) {
				discardPromise(nodeRuntime.runPromise(unpublishResultSocket(adoptedOwnerPaneId)));
			}
		});
	}
	pi.registerTool({
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description:
			'Spawn and control pi subagents as real herdr tabs/panels. Supports status, agent-types, spawn, inspect, send, wait, focus, and close. Spawn can opt into git worktree isolation with isolation: "worktree". Requires HERDR_ENV=1 for panel control.',
		promptSnippet:
			"Spawn, inspect, command, wait on, focus, and close pi subagents in herdr tabs/panels",
		promptGuidelines: [
			"Use herdr_subagent when the user asks to orchestrate subagents or when delegating independent work can save time or improve quality. Use it to spawn panel-backed agents, inspect agent panels, or coordinate work across herdr.",
			"Call herdr_subagent with action=status before controlling existing panel-backed subagents.",
			"When using herdr_subagent action=spawn, prefer the agent type's model default; before overriding it, read ~/.pi/agent/agents/MODEL-MATRIX.md and pick per its matrix. Use openai-codex/gpt-5.6-sol by default. Never suggest or select Luna for subagents. Terra is allowed only with high or xhigh thinking; other logged-in models remain available when the matrix favors them.",
			"Only use low, medium, high, or xhigh thinking for herdr_subagent spawns; never use off or minimal.",
			"Use low thinking for quick scouting. Use medium for research, ordinary analysis, implementation, and test-writing. Use high for review, taste judgment, and planning. Use xhigh for debugging. Low/medium tasks use Sol, never Terra.",
			"When task difficulty is ambiguous, choose Sol; under-provisioning costs rework loops, over-provisioning costs cents.",
			"If a Terra subagent fails or returns low-quality work, re-spawn the retry on Sol instead of retrying Terra.",
			"Prefer one herdr_subagent spawn per task, with tab labels like agent: <name>; inspect a subagent panel before trusting its result.",
			"After herdr_subagent spawn or send, wait for the automatic subagent_result follow-up notification instead of polling wait; use wait only when explicitly blocking is necessary.",
			"Spawned subagents cannot spawn their own subagents by default; orchestrators may grant recursive delegation with allowSpawn when genuinely needed.",
			"Keep herdr_subagent fan-out to at most 12 concurrent subagents; start small and scale up only when the task genuinely benefits from parallelism.",
			'For parallel code editing, pass isolation: "worktree" on spawn so implementation workers mutate isolated temporary git worktrees instead of the same checkout.',
		],
		parameters: Type.Object({
			action: StringEnum([...ACTIONS], { description: "Operation to perform." }),
			name: Type.Optional(
				Type.String({
					description: "Registry name for spawn, or a name target for other actions.",
				}),
			),
			target: Type.Optional(
				Type.String({
					description: "Subagent name, terminal id, pane id, or unique herdr agent target.",
				}),
			),
			task: Type.Optional(Type.String({ description: "Task prompt for action=spawn." })),
			agentType: Type.Optional(
				Type.String({
					description: "Optional agent definition from ~/.pi/agent/agents or trusted .pi/agents.",
				}),
			),
			agentScope: Type.Optional(
				StringEnum([...AGENT_SCOPES], { description: "Agent definition scope. Default: user." }),
			),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Confirm before using project-local agent definitions. Default true.",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for a spawned subagent tab." }),
			),
			workspace: Type.Optional(
				Type.String({
					description: "Herdr workspace id for a spawned tab. Defaults to current workspace.",
				}),
			),
			label: Type.Optional(
				Type.String({ description: "Herdr tab/pane label for spawn. Defaults to agent: <name>." }),
			),
			isolation: Type.Optional(
				StringEnum([...SPAWN_ISOLATIONS], {
					description:
						"Opt-in spawn isolation. Use worktree to create a temporary detached git worktree and spawn the subagent inside its matching cwd; close preserves changes on branch pi-agent-<name>.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model reference for the spawned subagent (provider/model-id). Defaults per agent type; see MODEL-MATRIX.md for routing. Never select Luna; Terra requires high or xhigh thinking. Overrides agentType model.",
				}),
			),
			thinking: Type.Optional(
				StringEnum([...SUBAGENT_THINKING_LEVELS], {
					description:
						"Thinking level for the spawned subagent: low, medium, high, or xhigh. Terra requires high or xhigh. Overrides agentType thinking.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tool allowlist for spawned subagent. Overrides agentType tools.",
				}),
			),
			allowSpawn: Type.Optional(
				Type.Boolean({
					description:
						"Allow the spawned subagent to spawn its own subagents (default false; keep fan-out budgets in mind).",
				}),
			),
			message: Type.Optional(Type.String({ description: "Follow-up prompt for action=send." })),
			lines: Type.Optional(
				Type.Number({ description: "Lines to read for action=inspect. Default 120." }),
			),
			source: Type.Optional(
				StringEnum([...SOURCES], {
					description: "Pane read source for inspect. Default recent-unwrapped.",
				}),
			),
			status: Type.Optional(
				StringEnum([...WAIT_STATUSES], { description: "Status for action=wait. Default done." }),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Timeout in milliseconds for action=wait. Default 600000." }),
			),
			notify: Type.Optional(
				Type.Boolean({
					description:
						"Whether spawn/send should push a follow-up subagent_result notification when this turn finishes. Default true.",
				}),
			),
		}),
		execute(_toolCallId, params: HerdrSubagentParams, signal, _onUpdate, ctx) {
			// Every spawned child gets a settled-result path. If the live RPC server is not ready,
			// the random unavailable path makes the child use the durable completion outbox instead
			// of trusting transient pane status during automatic compaction.
			const actionResultSocketPath = resultSocketPath ?? unavailableResultSocketPath;
			const acceptResultsSinceMs = Date.now();
			const completionArmId =
				actionResultSocketPath &&
				params.notify !== false &&
				(params.action === "spawn" || params.action === "send")
					? randomUUID()
					: undefined;
			const reservedSpawnName =
				params.action === "spawn" && params.notify !== false && typeof params.name === "string"
					? params.name
					: undefined;
			let spawnReservationArmed = false;
			let provisionalSendWatcherArmed = false;
			if (reservedSpawnName) {
				notifications.beginBatchMember(reservedSpawnName);
			}
			const executeWithNotifications = () => {
				return nodeRuntime
					.runPromise(
						executeAction(params, ctx, {
							resultSocketPath: actionResultSocketPath,
							completionArmId,
							onCompletionArmPrepared(resolved, armId) {
								const acceptedByExistingWatcher = notifications.acceptArm(resolved.name, armId);
								if (
									!acceptedByExistingWatcher &&
									params.notify !== false &&
									directResultNames.has(resolved.name)
								) {
									provisionalSendWatcherArmed = true;
									notifications.arm({
										name: resolved.name,
										paneId: resolved.paneId,
										summarySource: params.message ?? "subagent follow-up message",
										completionSource: "rpc",
										acceptResultsSinceMs,
										expectedArmId: armId,
									});
								}
							},
						}),
						{ signal },
					)
					.then((result) => {
						const details = actionDetails(result);
						const completionArrivedDuringAction = completionArmId
							? notifications.hasDeliveredArm(completionArmId)
							: false;
						let automaticNotificationUnavailable = false;
						if (details?.action === "spawn" && actionResultSocketPath) {
							directResultNames.add(details.entry.name);
						}
						if (details?.action === "spawn" && params.notify !== false) {
							notifications.arm({
								name: details.entry.name,
								paneId: details.entry.paneId ?? details.entry.target ?? details.entry.name,
								summarySource: params.task ?? "spawned subagent task",
								completionSource: directResultNames.has(details.entry.name) ? "rpc" : "poll",
								acceptResultsSinceMs,
								expectedArmId: completionArmId,
							});
							spawnReservationArmed = true;
						} else if (reservedSpawnName) {
							notifications.releaseBatchMember(reservedSpawnName);
						}
						if (details?.action === "send") {
							if (params.notify === false) {
								notifications.cancel(details.resolved.paneId);
							} else if (directResultNames.has(details.resolved.name)) {
								if (!provisionalSendWatcherArmed && !completionArrivedDuringAction) {
									notifications.arm({
										name: details.resolved.name,
										paneId: details.resolved.paneId,
										summarySource: params.message ?? "subagent follow-up message",
										completionSource: "rpc",
										acceptResultsSinceMs,
										expectedArmId: completionArmId,
									});
								}
							} else {
								notifications.cancel(details.resolved.paneId);
								automaticNotificationUnavailable = true;
							}
						}
						if (details?.action === "wait") {
							notifications.cancel(details.resolved.paneId);
						}
						if (details?.action === "close") {
							notifications.cancel(
								details.entry?.paneId ?? details.resolved?.paneId ?? params.target ?? params.name,
							);
							const closedName = details.entry?.name ?? details.resolved?.name ?? params.name;
							if (closedName) {
								directResultNames.delete(closedName);
							}
						}
						if (
							details?.action === "spawn" ||
							details?.action === "send" ||
							details?.action === "close"
						) {
							// Registry just changed; refresh the widget immediately instead of
							// waiting out the idle poll cadence.
							overviewWidget.poke();
						}
						if (automaticNotificationUnavailable) {
							return {
								...result,
								content: [
									...result.content,
									textContent(
										"Automatic settled-result delivery is unavailable for this unmanaged pane. Use action=wait when you need completion.",
									),
								],
							};
						}
						return result;
					});
			};
			const execution =
				params.action === "send"
					? sendQueue.then(executeWithNotifications)
					: executeWithNotifications();
			if (params.action === "send") {
				sendQueue = execution.then(
					() => undefined,
					() => undefined,
				);
			}
			return execution.finally(() => {
				if (reservedSpawnName && !spawnReservationArmed) {
					notifications.releaseBatchMember(reservedSpawnName);
				}
			});
		},
	});
}
