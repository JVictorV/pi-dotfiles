import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { liveAgent, runHerdr } from "./herdr-cli";
import { truncateForModel } from "./output";

const WATCH_POLL_INTERVAL_MS = 2_000;
const WATCH_IDLE_CONFIRMATIONS = 2;
const WATCH_STARTUP_IDLE_STABILITY_MS = 10_000;
const NOTIFICATION_TAIL_LINES = 60;
const CUSTOM_MESSAGE_TYPE = "herdr-subagent-result";
const ARM_BATCH_WINDOW_MS = 150;
const GROUP_JOIN_TIMEOUT_MS = 30_000;
const GROUP_JOIN_STRAGGLER_TIMEOUT_MS = 15_000;

type NotificationPi = Pick<ExtensionAPI, "sendMessage">;

type NotificationRequirements = ChildProcessSpawner | FileSystem | Path;
type RunPromise = <A>(
	effect: Effect.Effect<A, never, NotificationRequirements>,
	options?: { readonly signal?: AbortSignal },
) => Promise<A>;

type NotificationState = "done" | "blocked";

type ObservedState = "done" | "idle" | "blocked";

type NotificationObserved = ObservedState | "rpc" | "group";

type TimerHandle = ReturnType<typeof setTimeout>;

interface NotificationClock {
	readonly nowMillis: () => number;
	readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
	readonly clearTimeout: (handle: TimerHandle) => void;
}

interface NotificationManagerOptions {
	readonly armBatchWindowMs?: number;
	readonly groupJoinTimeoutMs?: number;
	readonly stragglerJoinTimeoutMs?: number;
	readonly clock?: NotificationClock;
}

interface ArmedNotification {
	readonly name: string;
	readonly paneId: string;
	readonly summarySource: string;
}

interface WatchedNotification extends ArmedNotification {
	readonly state: NotificationState;
	readonly observed: ObservedState;
	readonly paneTail: string;
}

interface ExternalNotification extends ArmedNotification {
	readonly state: NotificationState;
	readonly finalMessage: string;
}

interface ExternalNotificationResult {
	readonly status: NotificationState;
	readonly finalMessage: string;
	readonly sentAtMs: number;
}

interface WatcherSlot {
	readonly key: string;
	readonly name: string;
	readonly paneId: string;
	readonly summarySource: string;
	readonly armedAtMs: number;
	readonly controller: AbortController;
}

interface PendingArmBatch {
	readonly id: string;
	readonly keys: Set<string>;
	timeoutHandle: TimerHandle;
}

interface NotificationDelivery {
	readonly key: string;
	readonly name: string;
	readonly paneId: string;
	readonly state: NotificationState;
	readonly observed: NotificationObserved;
	readonly contentBlock: string;
	readonly individualContent: string;
}

interface CompletionGroup {
	readonly id: string;
	memberKeys: Set<string>;
	readonly completed: Map<string, NotificationDelivery>;
	timeoutHandle: TimerHandle | undefined;
	isStraggler: boolean;
}

/** Lifecycle controls for background subagent completion notifications. */
export interface SubagentNotificationManager {
	/** Reserve one spawn in the current dispatch-time batch before asynchronous spawn I/O starts. */
	beginBatchMember(name: string): void;
	/** Release a dispatch-time batch reservation for a spawn that failed before arming. */
	releaseBatchMember(name: string): void;
	/** Arm or re-arm one notification watcher for a subagent turn. */
	arm(notification: ArmedNotification): void;
	/** Deliver an external RPC result if, and only if, the matching watcher is armed. */
	deliverExternal(name: string, result: ExternalNotificationResult): void;
	/** Cancel any watcher matching a subagent name, pane id, or tool target. */
	cancel(target: string | undefined): void;
	/** Cancel all active notification watchers. */
	cancelAll(): void;
}

const defaultNotificationClock: NotificationClock = {
	nowMillis: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

const watcherKey = (name: string): string => name;

const summarizeSource = (source: string): string => {
	const compact = source.replaceAll(/\s+/g, " ").trim();
	if (compact.length <= 100) {
		return compact;
	}
	return `${compact.slice(0, 97)}...`;
};

const escapeXmlText = (text: string): string =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const stateVerb = (state: NotificationState): string =>
	state === "blocked" ? "needs attention" : "finished";

const guidanceFor = (state: NotificationState): string =>
	state === "blocked"
		? "Guidance: inspect the panel before trusting the result; use herdr_subagent send or focus to unblock."
		: "Guidance: inspect the panel before trusting the result; do not duplicate the subagent's work.";

const watchedResultBlockFor = (notification: WatchedNotification): string => {
	const sourceSummary = summarizeSource(notification.summarySource);
	const observedNote =
		notification.observed === "idle" ? " (observed idle: pane may have been viewed)" : "";
	const summary = `Subagent ${notification.name} ${stateVerb(notification.state)}${observedNote}: ${sourceSummary}`;
	return `<subagent_result name="${escapeXmlText(notification.name)}" state="${notification.state}" pane="${escapeXmlText(notification.paneId)}">
<summary>${escapeXmlText(summary)}</summary>
<pane_tail>
${escapeXmlText(notification.paneTail)}
</pane_tail>
</subagent_result>`;
};

const externalResultBlockFor = (notification: ExternalNotification): string => {
	const sourceSummary = summarizeSource(notification.summarySource);
	const summary = `Subagent ${notification.name} ${stateVerb(notification.state)}: ${sourceSummary}`;
	return `<subagent_result name="${escapeXmlText(notification.name)}" state="${notification.state}" pane="${escapeXmlText(notification.paneId)}">
<summary>${escapeXmlText(summary)}</summary>
<final_message>
${escapeXmlText(notification.finalMessage)}
</final_message>
</subagent_result>`;
};

const envelopeFor = (notification: WatchedNotification): string =>
	`${watchedResultBlockFor(notification)}\n\n${guidanceFor(notification.state)}`;

const externalEnvelopeFor = (notification: ExternalNotification): string =>
	`${externalResultBlockFor(notification)}\n\n${guidanceFor(notification.state)}`;

const groupGuidanceFor = (
	deliveries: ReadonlyArray<NotificationDelivery>,
	partial: boolean,
): string => {
	if (partial) {
		return "Guidance: inspect the delivered panels before trusting the result; remaining grouped subagents are still running and will be re-batched.";
	}
	if (deliveries.some((delivery) => delivery.state === "blocked")) {
		return "Guidance: inspect the panels before trusting the result; use herdr_subagent send or focus for blocked members.";
	}
	return "Guidance: inspect the panels before trusting the result; do not duplicate the subagents' work.";
};

const groupEnvelopeFor = (
	deliveries: ReadonlyArray<NotificationDelivery>,
	partial: boolean,
	pendingCount: number,
): string => {
	const groupState = partial ? "partial" : "complete";
	const blocks = deliveries.map((delivery) => delivery.contentBlock).join("\n\n");
	return `<subagent_result_group state="${groupState}" partial="${String(partial)}" delivered="${deliveries.length}" pending="${pendingCount}">
${blocks}
</subagent_result_group>

${groupGuidanceFor(deliveries, partial)}`;
};

const watchedDeliveryFor = (
	key: string,
	notification: WatchedNotification,
): NotificationDelivery => ({
	key,
	name: notification.name,
	paneId: notification.paneId,
	state: notification.state,
	observed: notification.observed,
	contentBlock: watchedResultBlockFor(notification),
	individualContent: envelopeFor(notification),
});

const externalDeliveryFor = (
	key: string,
	notification: ExternalNotification,
): NotificationDelivery => ({
	key,
	name: notification.name,
	paneId: notification.paneId,
	state: notification.state,
	observed: "rpc",
	contentBlock: externalResultBlockFor(notification),
	individualContent: externalEnvelopeFor(notification),
});

const waitForNotificationState: (
	notification: ArmedNotification,
) => Effect.Effect<ObservedState, never, NotificationRequirements> = Effect.fnUntraced(
	function* (notification) {
		let consecutiveSettled = 0;
		let firstSettledAt: number | undefined;
		let observedWorking = false;

		const poll: Effect.Effect<ObservedState, never, NotificationRequirements> = Effect.suspend(() =>
			Effect.gen(function* () {
				const agent = yield* liveAgent(notification.paneId);
				const status = agent?.agent_status ?? "unknown";
				if (status === "working") {
					observedWorking = true;
					consecutiveSettled = 0;
					firstSettledAt = undefined;
				} else if (status === "done" || status === "blocked" || status === "idle") {
					// A settled status seen before any working phase is suspect right after arming: on a
					// send re-arm the pane still reports the PREVIOUS turn's terminal status until the
					// subagent picks the new message up, so an instant `done` here delivers a stale
					// notification with the old result. Trust settled statuses only after an observed
					// working phase, or after they hold through the startup-stability window.
					const now = yield* Clock.currentTimeMillis;
					firstSettledAt ??= now;
					consecutiveSettled += 1;
					const trusted = observedWorking
						? status !== "idle" || consecutiveSettled >= WATCH_IDLE_CONFIRMATIONS
						: consecutiveSettled >= WATCH_IDLE_CONFIRMATIONS &&
							now - firstSettledAt >= WATCH_STARTUP_IDLE_STABILITY_MS;
					if (trusted) {
						return status;
					}
				} else {
					consecutiveSettled = 0;
					firstSettledAt = undefined;
				}
				yield* Effect.sleep(WATCH_POLL_INTERVAL_MS);
				return yield* poll;
			}),
		);

		return yield* poll;
	},
);

const readPaneTail = (paneId: string): Effect.Effect<string, never, NotificationRequirements> =>
	runHerdr([
		"pane",
		"read",
		paneId,
		"--source",
		"recent-unwrapped",
		"--lines",
		String(NOTIFICATION_TAIL_LINES),
	]).pipe(
		Effect.map((outcome) => truncateForModel(outcome.stdout, NOTIFICATION_TAIL_LINES).text),
		Effect.catch(() => Effect.succeed("[pane tail unavailable]")),
	);

const watchSubagent: (
	notification: ArmedNotification,
) => Effect.Effect<WatchedNotification, never, NotificationRequirements> = Effect.fnUntraced(
	function* (notification) {
		const observed = yield* waitForNotificationState(notification);
		const paneTail = yield* readPaneTail(notification.paneId);
		return {
			...notification,
			state: observed === "blocked" ? "blocked" : "done",
			observed,
			paneTail,
		};
	},
);

const sendNotification = (
	pi: NotificationPi,
	notification: ArmedNotification & { readonly state: NotificationState },
	content: string,
	observed: NotificationObserved,
): Effect.Effect<void, never> =>
	Effect.try({
		try: () => {
			pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content,
					display: true,
					details: {
						name: notification.name,
						paneId: notification.paneId,
						state: notification.state,
						observed,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

const sendGroupedNotification = (
	pi: NotificationPi,
	deliveries: ReadonlyArray<NotificationDelivery>,
	partial: boolean,
	pendingCount: number,
): Effect.Effect<void, never> =>
	Effect.try({
		try: () => {
			const groupState: NotificationState = deliveries.some(
				(delivery) => delivery.state === "blocked",
			)
				? "blocked"
				: "done";
			pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: groupEnvelopeFor(deliveries, partial, pendingCount),
					display: true,
					details: {
						group: true,
						names: deliveries.map((delivery) => delivery.name),
						paneIds: deliveries.map((delivery) => delivery.paneId),
						state: groupState,
						observed: "group",
						partial,
						pending: pendingCount,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

const deliverIndividualNotification = (
	pi: NotificationPi,
	delivery: NotificationDelivery,
): Effect.Effect<void, never> =>
	sendNotification(
		pi,
		{
			name: delivery.name,
			paneId: delivery.paneId,
			summarySource: "",
			state: delivery.state,
		},
		delivery.individualContent,
		delivery.observed,
	);

/** Create a session-scoped manager for background herdr subagent notifications. */
export const createSubagentNotificationManager = (
	pi: NotificationPi,
	runPromise: RunPromise,
	options: NotificationManagerOptions = {},
): SubagentNotificationManager => {
	const notificationClock = options.clock ?? defaultNotificationClock;
	const armBatchWindowMs = options.armBatchWindowMs ?? ARM_BATCH_WINDOW_MS;
	const groupJoinTimeoutMs = options.groupJoinTimeoutMs ?? GROUP_JOIN_TIMEOUT_MS;
	const stragglerJoinTimeoutMs = options.stragglerJoinTimeoutMs ?? GROUP_JOIN_STRAGGLER_TIMEOUT_MS;
	const watchers = new Map<string, WatcherSlot>();
	const groups = new Map<string, CompletionGroup>();
	const keyToGroup = new Map<string, string>();
	// Content fingerprints of already-delivered external results, per subagent name. A subagent
	// process can re-emit agent_end with an unchanged final message after a re-arm (fresh
	// sentAtMs defeats the armedAtMs guard); identical redelivery is always stale.
	const deliveredExternal = new Map<string, string>();
	let nextBatchId = 1;
	let currentArmBatch: PendingArmBatch | undefined;

	const deliveryRecordsFor = (group: CompletionGroup): NotificationDelivery[] => {
		const records: NotificationDelivery[] = [];
		for (const key of group.memberKeys) {
			const record = group.completed.get(key);
			if (record) {
				records.push(record);
			}
		}
		return records;
	};

	const clearBatch = (batch: PendingArmBatch): void => {
		notificationClock.clearTimeout(batch.timeoutHandle);
		if (currentArmBatch === batch) {
			currentArmBatch = undefined;
		}
	};

	const cleanupGroup = (groupId: string): void => {
		const group = groups.get(groupId);
		if (!group) {
			return;
		}
		if (group.timeoutHandle) {
			notificationClock.clearTimeout(group.timeoutHandle);
			group.timeoutHandle = undefined;
		}
		for (const key of group.memberKeys) {
			keyToGroup.delete(key);
		}
		groups.delete(groupId);
	};

	const deliverGroup = (group: CompletionGroup, partial: boolean, pendingCount: number): void => {
		const deliveries = deliveryRecordsFor(group);
		if (deliveries.length === 0) {
			return;
		}
		cleanupGroup(group.id);
		Effect.runSync(sendGroupedNotification(pi, deliveries, partial, pendingCount));
	};

	const onGroupTimeout = (groupId: string): void => {
		const group = groups.get(groupId);
		if (!group || group.completed.size === 0) {
			return;
		}
		group.timeoutHandle = undefined;
		const remaining = new Set<string>();
		for (const key of group.memberKeys) {
			if (!group.completed.has(key)) {
				remaining.add(key);
			}
		}
		const deliveries = deliveryRecordsFor(group);
		for (const delivery of deliveries) {
			keyToGroup.delete(delivery.key);
		}
		Effect.runSync(sendGroupedNotification(pi, deliveries, true, remaining.size));
		group.completed.clear();
		group.memberKeys = remaining;
		group.isStraggler = true;
		if (remaining.size === 0) {
			cleanupGroup(group.id);
		}
	};

	const startGroupTimeout = (group: CompletionGroup): void => {
		if (group.timeoutHandle) {
			return;
		}
		const delayMs = group.isStraggler ? stragglerJoinTimeoutMs : groupJoinTimeoutMs;
		group.timeoutHandle = notificationClock.setTimeout(() => onGroupTimeout(group.id), delayMs);
	};

	const maybeDeliverCompletedGroup = (group: CompletionGroup): void => {
		if (group.completed.size >= group.memberKeys.size) {
			deliverGroup(group, false, 0);
			return;
		}
		if (group.completed.size > 0) {
			startGroupTimeout(group);
		}
	};

	const finalizeArmBatch = (batch: PendingArmBatch): void => {
		clearBatch(batch);
		const batchKeys = [...batch.keys];
		if (batchKeys.length < 2) {
			return;
		}
		const group: CompletionGroup = {
			id: batch.id,
			memberKeys: new Set(batchKeys),
			completed: new Map(),
			timeoutHandle: undefined,
			isStraggler: false,
		};
		groups.set(group.id, group);
		for (const key of batchKeys) {
			keyToGroup.set(key, group.id);
		}
	};

	const finalizeCurrentArmBatchFor = (key: string): void => {
		const batch = currentArmBatch;
		if (!batch || !batch.keys.has(key)) {
			return;
		}
		finalizeArmBatch(batch);
	};

	const removeKeyFromCurrentBatch = (key: string): void => {
		const batch = currentArmBatch;
		if (!batch || !batch.keys.has(key)) {
			return;
		}
		batch.keys.delete(key);
		if (batch.keys.size === 0) {
			clearBatch(batch);
		}
	};

	const removeKeyFromGroup = (key: string): void => {
		const groupId = keyToGroup.get(key);
		if (!groupId) {
			return;
		}
		const group = groups.get(groupId);
		keyToGroup.delete(key);
		if (!group) {
			return;
		}
		group.memberKeys.delete(key);
		group.completed.delete(key);
		if (group.memberKeys.size === 0) {
			cleanupGroup(group.id);
			return;
		}
		if (group.memberKeys.size === 1) {
			const remainingKey = [...group.memberKeys][0];
			const remainingDelivery = remainingKey ? group.completed.get(remainingKey) : undefined;
			cleanupGroup(group.id);
			if (remainingDelivery) {
				Effect.runSync(deliverIndividualNotification(pi, remainingDelivery));
			}
			return;
		}
		maybeDeliverCompletedGroup(group);
	};

	const cancelKey = (key: string): void => {
		const existing = watchers.get(key);
		if (existing) {
			existing.controller.abort();
			watchers.delete(key);
		}
		removeKeyFromCurrentBatch(key);
		removeKeyFromGroup(key);
	};

	const resetArmBatchTimer = (batch: PendingArmBatch): void => {
		notificationClock.clearTimeout(batch.timeoutHandle);
		batch.timeoutHandle = notificationClock.setTimeout(
			() => finalizeArmBatch(batch),
			armBatchWindowMs,
		);
	};

	const ensureArmBatch = (): PendingArmBatch => {
		if (currentArmBatch) {
			return currentArmBatch;
		}
		const id = `arm-batch-${nextBatchId}`;
		nextBatchId += 1;
		const batch: PendingArmBatch = {
			id,
			keys: new Set(),
			timeoutHandle: notificationClock.setTimeout(() => undefined, 0),
		};
		resetArmBatchTimer(batch);
		currentArmBatch = batch;
		return batch;
	};

	const addKeyToCurrentBatch = (key: string): void => {
		const batch = ensureArmBatch();
		batch.keys.add(key);
		resetArmBatchTimer(batch);
	};

	const processCompletion = (delivery: NotificationDelivery): void => {
		finalizeCurrentArmBatchFor(delivery.key);
		watchers.delete(delivery.key);
		const groupId = keyToGroup.get(delivery.key);
		if (!groupId) {
			Effect.runSync(deliverIndividualNotification(pi, delivery));
			return;
		}
		const group = groups.get(groupId);
		if (!group) {
			keyToGroup.delete(delivery.key);
			Effect.runSync(deliverIndividualNotification(pi, delivery));
			return;
		}
		group.completed.set(delivery.key, delivery);
		maybeDeliverCompletedGroup(group);
	};

	const manager: SubagentNotificationManager = {
		beginBatchMember(name) {
			addKeyToCurrentBatch(watcherKey(name));
		},
		releaseBatchMember(name) {
			const key = watcherKey(name);
			if (watchers.has(key)) {
				return;
			}
			removeKeyFromCurrentBatch(key);
			removeKeyFromGroup(key);
		},
		arm(notification) {
			const key = watcherKey(notification.name);
			const reservedInCurrentBatch = currentArmBatch?.keys.has(key) ?? false;
			const reservedInGroup = keyToGroup.has(key) && !watchers.has(key);
			const existing = watchers.get(key);
			if (existing) {
				existing.controller.abort();
				watchers.delete(key);
				removeKeyFromCurrentBatch(key);
				removeKeyFromGroup(key);
			}
			const controller = new AbortController();
			const slot: WatcherSlot = {
				key,
				name: notification.name,
				paneId: notification.paneId,
				summarySource: notification.summarySource,
				armedAtMs: notificationClock.nowMillis(),
				controller,
			};
			watchers.set(key, slot);
			// Pi does not expose a stable model-turn id at the tool boundary. Spawn calls reserve
			// batch membership synchronously before asynchronous herdr I/O starts; this later arm
			// attaches the pane id to that reservation. Sends, and direct manager users without a
			// reservation, still batch by arm time. A single-member batch is left ungrouped so solo
			// subagents notify exactly as before.
			if (!reservedInCurrentBatch && !reservedInGroup) {
				addKeyToCurrentBatch(key);
			}
			runPromise(watchSubagent(notification), { signal: controller.signal })
				.then((watched) => {
					if (watchers.get(key) !== slot) {
						return;
					}
					processCompletion(watchedDeliveryFor(key, watched));
				})
				.catch(() => {
					if (watchers.get(key) === slot) {
						watchers.delete(key);
						removeKeyFromCurrentBatch(key);
						removeKeyFromGroup(key);
					}
				});
		},
		deliverExternal(name, result) {
			const key = watcherKey(name);
			const slot = watchers.get(key);
			if (!slot) {
				return;
			}
			if (result.sentAtMs < slot.armedAtMs) {
				return;
			}
			const fingerprint = `${result.status}:${result.finalMessage}`;
			if (deliveredExternal.get(name) === fingerprint) {
				// Duplicate of an already-delivered result: drop it WITHOUT consuming the watcher, so
				// the genuinely-new completion of the current turn can still notify.
				return;
			}
			deliveredExternal.set(name, fingerprint);
			slot.controller.abort();
			processCompletion(
				externalDeliveryFor(key, {
					name: slot.name,
					paneId: slot.paneId,
					summarySource: slot.summarySource,
					state: result.status,
					finalMessage: truncateForModel(result.finalMessage).text,
				}),
			);
		},
		cancel(target) {
			if (!target) {
				return;
			}
			for (const slot of watchers.values()) {
				if (slot.name === target || slot.paneId === target) {
					cancelKey(slot.key);
				}
			}
		},
		cancelAll() {
			for (const slot of watchers.values()) {
				slot.controller.abort();
			}
			watchers.clear();
			if (currentArmBatch) {
				clearBatch(currentArmBatch);
			}
			for (const group of groups.values()) {
				if (group.timeoutHandle) {
					notificationClock.clearTimeout(group.timeoutHandle);
					group.timeoutHandle = undefined;
				}
			}
			groups.clear();
			keyToGroup.clear();
			deliveredExternal.clear();
		},
	};

	return manager;
};
