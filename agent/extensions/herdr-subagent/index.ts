import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { herdrSdkLayerFromOptions } from "@herdr/sdk";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, ConfigProvider, Duration, Effect, Layer, ManagedRuntime } from "effect";

import { DEFAULT_SUBAGENT_MODEL } from "./actions";
import { createSubagentCompletionCoordinator } from "./completion";
import {
	configurationProvider,
	herdrSubagentName,
	herdrSubagentResultSocket,
	isHerdrSubagentSession,
	isRunningInsideHerdr,
} from "./environment";
import { currentPane } from "./herdr-client";
import { createSubagentNotificationManager, refreshSubagentResultGuidance } from "./notifications";
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
} from "./types";

const nodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const sdkLayer = herdrSdkLayerFromOptions({
	requestTimeout: Duration.seconds(30),
	application: { name: "pi-herdr-subagent" },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type TextPart = { readonly type: "text"; readonly text: string };

type AssistantMessageLike = {
	readonly stopReason?: unknown;
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
			// A terminating tool (such as new_context) can settle an inner run while
			// the task continues. Its commentary is not a final subagent report.
			if (
				message.stopReason !== "stop" ||
				message.content.some((part) => isRecord(part) && part.type === "toolCall")
			)
				return "";
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

/** Register herdr-backed pi subagent orchestration tools. */
export default function herdrSubagentExtension(pi: ExtensionAPI) {
	// Layers acquire lazily. Each extension instance owns its SDK compatibility
	// cache and releases the runtime on quit, reload, or session replacement.
	const nodeRuntime = ManagedRuntime.make(
		Layer.merge(nodeLayer, sdkLayer).pipe(
			// Keep the provider available to currentPane as well as SDK acquisition.
			Layer.provideMerge(ConfigProvider.layer(configurationProvider())),
		),
	);
	let stopped = false;
	let rpcStartup: Promise<void> | undefined;
	const notifications = createSubagentNotificationManager(pi, (effect, options) =>
		nodeRuntime.runPromise(effect, options),
	);
	const completion = createSubagentCompletionCoordinator(notifications, (effect, options) =>
		nodeRuntime.runPromise(effect, options),
	);
	let rpcServer: SubagentRpcServer | undefined;
	let rpcServerStarting = false;
	let resultSocketPath: string | undefined;
	let latestFinalAssistantText: string | undefined;
	let latestCompletionArmId: string | undefined;
	const unavailableResultSocketPath = subagentRpcSocketPath("unavailable");
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
							completion.adoptDirectResult(entry.name);
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
		pi.on("context", (event, ctx) => ({
			messages: refreshSubagentResultGuidance(event.messages, ctx.sessionManager.getBranch()),
		}));
		pi.on("session_start", () => {
			if (!isRunningInsideHerdr() || isHerdrSubagentSession() || rpcServer || rpcServerStarting) {
				return;
			}
			rpcServerStarting = true;
			rpcStartup = nodeRuntime
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
						if (stopped) {
							await server.close();
							return;
						}
						rpcServer = server;
						resultSocketPath = server.socketPath;
						await adoptOrphanedRegistryEntries(server.socketPath);
					},
					() => {
						rpcServerStarting = false;
					},
				);
			discardPromise(rpcStartup);
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
		pi.on("session_shutdown", async () => {
			if (stopped) return;
			stopped = true;
			notifications.cancelAll();
			await rpcStartup?.catch(() => undefined);
			completion.reset();
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
			await Promise.all([
				server?.close(),
				adoptedOwnerPaneId
					? nodeRuntime.runPromise(unpublishResultSocket(adoptedOwnerPaneId))
					: undefined,
			]).finally(() => nodeRuntime.dispose());
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
			"Use herdr_subagent for delegated work. Read the herdr-subagents skill for the workflow, and call action=status before controlling existing panels.",
			"For herdr_subagent spawns, prefer agentType defaults. Read ~/.pi/agent/agents/MODEL-MATRIX.md before model overrides. Never suggest or select Luna for subagents. Terra is allowed only with high or xhigh thinking; other spawns accept low, medium, high, or xhigh.",
			"After herdr_subagent spawn or send, use the automatic final report directly. Use wait only when blocking is necessary, not for polling. Inspect progress samples, missing details, or separate verification needs; do not reread or acknowledge a final report already used.",
			'For parallel code editing with herdr_subagent, use isolation: "worktree". Keep at most 12 concurrent subagents. Recursive delegation requires an explicit allowSpawn grant.',
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
					description: `Model reference (provider/model-id). Overrides agentType model; plain spawns default to ${DEFAULT_SUBAGENT_MODEL}. See MODEL-MATRIX.md for override policy. Never select Luna; Terra requires high or xhigh thinking.`,
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
						"Whether spawn/send should deliver a subagent_result notification before the parent's next model response when this turn finishes. Default true.",
				}),
			),
		}),
		execute(_toolCallId, params: HerdrSubagentParams, signal, _onUpdate, ctx) {
			// Every spawned child gets a settled-result path. If the live RPC server is not ready,
			// the random unavailable path makes the child use the durable completion outbox instead
			// of trusting transient pane status during automatic compaction.
			const actionResultSocketPath = resultSocketPath ?? unavailableResultSocketPath;
			return completion
				.execute(params, ctx, { signal, resultSocketPath: actionResultSocketPath })
				.then(({ result, registryChanged, automaticNotificationUnavailable }) => {
					if (registryChanged) {
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
		},
	});
}
