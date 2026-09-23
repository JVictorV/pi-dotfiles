import { randomUUID } from "node:crypto";

import type { HerdrSdk } from "@herdr/sdk";
import { Effect, Result } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";

import { type ActionOutcome, executeAction, type HerdrActionEnvironment } from "./actions";
import { type ActionRejected, failAction } from "./errors";
import type { SubagentNotificationManager } from "./notifications";
import { readSubagentCompletionArm, writeSubagentCompletionArm } from "./subagent-rpc";
import type { HerdrSubagentParams, PiToolContext, ResolvedPane } from "./types";

type CompletionRequirements = HerdrSdk | FileSystem | Path;

type CompletionRunPromise = <A, E>(
	effect: Effect.Effect<A, E, CompletionRequirements>,
	options?: { readonly signal?: AbortSignal },
) => Promise<A>;

/**
 * Action-scoped completion arm.
 *
 * Run pane input through {@link CompletionArm.runInput} when completion delivery
 * is enabled. Sends prepare watcher acceptance before persisting the durable arm
 * and dispatching input. Spawns persist the arm before launch; their batch
 * reservation and buffered results cover the time before watcher installation.
 * An ambiguous send failure restores the previous durable arm while keeping the
 * attempted completion accepted.
 */
export interface CompletionArm {
	/** Persist the arm before dispatch, with send-specific acceptance and rollback. */
	runInput<A, E, R>(
		resolved: ResolvedPane,
		input: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E | ActionRejected, R>;
}

/** One coordinated action result plus the presentation facts the entrypoint needs. */
export interface CompletionExecution {
	/** The action outcome with inspection receipts already attached. */
	readonly result: ActionOutcome;
	/** The registry changed, so presentation should refresh. */
	readonly registryChanged: boolean;
	/** Automatic settled-result delivery is unavailable for this unmanaged pane. */
	readonly automaticNotificationUnavailable: boolean;
}

/** Session-scoped coordinator for herdr subagent completion delivery. */
export interface SubagentCompletionCoordinator {
	/**
	 * Run one action and coordinate its completion lifecycle.
	 *
	 * Sends are serialized so concurrent follow-ups cannot race the durable arm.
	 * Spawn batch reservations are released when a spawn fails before arming.
	 */
	execute(
		params: HerdrSubagentParams,
		ctx: PiToolContext,
		options: { readonly signal?: AbortSignal; readonly resultSocketPath: string },
	): Promise<CompletionExecution>;
	/** Register a subagent whose results arrive through the direct RPC/outbox path. */
	adoptDirectResult(name: string): void;
	/** Clear session-scoped direct-result state. */
	reset(): void;
}

/** Create the session-scoped completion coordinator. */
export const createSubagentCompletionCoordinator = (
	notifications: SubagentNotificationManager,
	runPromise: CompletionRunPromise,
): SubagentCompletionCoordinator => {
	const directResultNames = new Set<string>();
	let sendQueue: Promise<void> = Promise.resolve();

	const execute: SubagentCompletionCoordinator["execute"] = (params, ctx, execOptions) => {
		const { signal, resultSocketPath } = execOptions;
		// Capture inspection receipts before asynchronous pane I/O so the returned
		// text can acknowledge exactly the completions that were visible up front.
		const acknowledgeInspection =
			params.action === "inspect" ? notifications.beginInspection() : undefined;
		const acceptResultsSinceMs = Date.now();
		const notify = params.notify !== false;
		const armId =
			notify && (params.action === "spawn" || params.action === "send") ? randomUUID() : undefined;
		const reservedSpawnName =
			params.action === "spawn" && notify && typeof params.name === "string"
				? params.name
				: undefined;
		let spawnReservationArmed = false;
		let provisionalSendWatcherArmed = false;
		if (reservedSpawnName) {
			notifications.beginBatchMember(reservedSpawnName);
		}

		const completionArm: CompletionArm | undefined = armId
			? {
					runInput(resolved, input) {
						return Effect.gen(function* () {
							const previousArmId = yield* readSubagentCompletionArm(resolved.name);
							if (params.action === "send") {
								const acceptedByExistingWatcher = notifications.acceptArm(resolved.name, armId);
								if (!acceptedByExistingWatcher && directResultNames.has(resolved.name)) {
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
							}
							const armed = yield* writeSubagentCompletionArm(resolved.name, armId);
							if (!armed) {
								return yield* failAction(
									`Could not arm direct result delivery for ${resolved.name}.`,
								);
							}
							const outcome = yield* input.pipe(Effect.result);
							if (Result.isFailure(outcome)) {
								if (params.action === "send") {
									// The message may have reached the pane, so keep the arm accepted and
									// restore the previous durable identity for later settlements.
									yield* writeSubagentCompletionArm(resolved.name, previousArmId ?? "");
								}
								return yield* Effect.fail(outcome.failure);
							}
							return outcome.success;
						});
					},
				}
			: undefined;
		const environment: HerdrActionEnvironment = {
			resultSocketPath,
			...(completionArm ? { completionArm } : {}),
		};

		const reconcile = (result: ActionOutcome): CompletionExecution => {
			const details = result.details;
			const completionArrivedDuringAction = armId ? notifications.hasDeliveredArm(armId) : false;
			let automaticNotificationUnavailable = false;
			switch (details.action) {
				case "spawn": {
					if (details.entry && resultSocketPath) {
						directResultNames.add(details.entry.name);
					}
					if (details.entry && notify) {
						notifications.arm({
							name: details.entry.name,
							paneId: details.entry.paneId ?? details.entry.target ?? details.entry.name,
							summarySource: params.task ?? "spawned subagent task",
							completionSource: directResultNames.has(details.entry.name) ? "rpc" : "poll",
							acceptResultsSinceMs,
							expectedArmId: armId,
						});
						spawnReservationArmed = true;
					} else if (reservedSpawnName) {
						notifications.releaseBatchMember(reservedSpawnName);
					}
					break;
				}
				case "send": {
					if (!notify) {
						notifications.cancel(details.resolved.paneId);
					} else if (directResultNames.has(details.resolved.name)) {
						if (!provisionalSendWatcherArmed && !completionArrivedDuringAction) {
							notifications.arm({
								name: details.resolved.name,
								paneId: details.resolved.paneId,
								summarySource: params.message ?? "subagent follow-up message",
								completionSource: "rpc",
								acceptResultsSinceMs,
								expectedArmId: armId,
							});
						}
					} else {
						notifications.cancel(details.resolved.paneId);
						automaticNotificationUnavailable = true;
					}
					break;
				}
				case "wait": {
					notifications.cancel(details.resolved.paneId);
					break;
				}
				case "close": {
					notifications.cancel(
						details.entry?.paneId ?? details.resolved?.paneId ?? params.target ?? params.name,
					);
					const closedName = details.entry?.name ?? details.resolved?.name ?? params.name;
					if (closedName) {
						directResultNames.delete(closedName);
					}
					break;
				}
				default:
					break;
			}

			let finalResult = result;
			if (!result.isError && details.action === "inspect" && acknowledgeInspection) {
				const consumedCompletions = acknowledgeInspection(
					details.resolved.name,
					details.resolved.paneId,
					result.content.map((part) => part.text).join("\n"),
				);
				finalResult = { ...result, details: { ...details, consumedCompletions } };
			}
			const registryChanged =
				(details.action === "spawn" && Boolean(details.entry)) ||
				details.action === "send" ||
				details.action === "close";
			return { result: finalResult, registryChanged, automaticNotificationUnavailable };
		};

		const runAction = (): Promise<CompletionExecution> =>
			runPromise(executeAction(params, ctx, environment), { signal }).then(reconcile);
		const execution = params.action === "send" ? sendQueue.then(runAction) : runAction();
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
	};

	return {
		execute,
		adoptDirectResult(name) {
			directResultNames.add(name);
		},
		reset() {
			directResultNames.clear();
		},
	};
};
