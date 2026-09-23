import { stripVTControlCharacters } from "node:util";

import type { ContextEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Option, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { HerdrSdk } from "@herdr/sdk";

import { liveAgent, readPane } from "./herdr-client";
import { truncateForModel } from "./output";
import { takePersistedSubagentCompletion } from "./subagent-rpc";

const WATCH_POLL_INTERVAL_MS = 2_000;
const WATCH_IDLE_CONFIRMATIONS = 2;
const WATCH_STARTUP_IDLE_STABILITY_MS = 10_000;
const NOTIFICATION_TAIL_LINES = 60;
const CUSTOM_MESSAGE_TYPE = "herdr-subagent-result";
const ARM_BATCH_WINDOW_MS = 150;
const GROUP_JOIN_TIMEOUT_MS = 30_000;
const GROUP_JOIN_STRAGGLER_TIMEOUT_MS = 15_000;
const MAX_TRACKED_DELIVERED_ARMS = 256;

type NotificationPi = Pick<ExtensionAPI, "sendMessage">;

type NotificationRequirements = HerdrSdk | FileSystem | Path;
type RunPromise = <A>(
	effect: Effect.Effect<A, never, NotificationRequirements>,
	options?: { readonly signal?: AbortSignal },
) => Promise<A>;

type NotificationState = "done" | "blocked";
type CompletionSource = "poll" | "rpc";

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
	readonly completionId?: string;
	readonly name: string;
	readonly paneId: string;
	readonly summarySource: string;
	readonly completionSource?: CompletionSource;
	readonly acceptResultsSinceMs?: number;
	readonly expectedArmId?: string;
}

interface WatchedNotification extends ArmedNotification {
	readonly state: NotificationState;
	readonly observed: ObservedState;
	readonly paneTail: string;
}

interface ExternalNotification extends ArmedNotification {
	readonly reportKind: "final" | "sample";
	readonly state: NotificationState;
	readonly finalMessage: string;
}

interface ExternalNotificationResult {
	readonly status: NotificationState;
	readonly finalMessage: string;
	readonly sentAtMs: number;
	readonly completionId?: string;
	readonly armId?: string;
}

interface WatcherSlot {
	readonly key: string;
	readonly name: string;
	readonly paneId: string;
	readonly summarySource: string;
	readonly armedAtMs: number;
	readonly acceptedArmIds: Set<string>;
	readonly controller: AbortController;
}

interface PendingArmBatch {
	readonly id: string;
	readonly keys: Set<string>;
	timeoutHandle: TimerHandle;
}

interface NotificationDelivery {
	readonly reportKind: "final" | "sample";
	readonly completionId: string;
	readonly reportText: string;
	readonly key: string;
	readonly name: string;
	readonly paneId: string;
	readonly state: NotificationState;
	readonly observed: NotificationObserved;
	readonly contentBlock: string;
	readonly individualContent: string;
}

interface WatchCompletion {
	readonly notification?: WatchedNotification;
	readonly name?: string;
	readonly result?: ExternalNotificationResult;
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
	/** Let the current watcher accept the arm published for an in-flight send attempt. */
	acceptArm(target: string, armId: string): boolean;
	/** Test whether a watcher already delivered the result for an arm. */
	hasDeliveredArm(armId: string): boolean;
	/** Deliver an external RPC result if, and only if, the matching watcher is armed. */
	deliverExternal(name: string, result: ExternalNotificationResult): void;
	/** Capture the latest known report per pane before inspection. Acknowledge only a full report in its returned text. */
	beginInspection(): (name: string, paneId: string, text: string) => ReadonlyArray<string>;
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

const ClosedPanelIdentity = Schema.Struct({
	name: Schema.String,
	paneId: Schema.optional(Schema.String),
});
const decodeClosedAction = Schema.decodeUnknownOption(
	Schema.Struct({
		action: Schema.Literal("close"),
		entry: Schema.optional(ClosedPanelIdentity),
		resolved: Schema.optional(ClosedPanelIdentity),
	}),
);

const panelKey = (name: string, paneId: string): string => JSON.stringify([name, paneId]);

const decodeInspection = Schema.decodeUnknownOption(
	Schema.Struct({
		action: Schema.Literal("inspect"),
		resolved: ClosedPanelIdentity,
		consumedCompletions: Schema.optional(Schema.Array(Schema.String)),
	}),
);
const decodeNewWork = Schema.decodeUnknownOption(
	Schema.Struct({
		action: Schema.Literals(["send", "spawn"]),
		resolved: Schema.optional(ClosedPanelIdentity),
		entry: Schema.optional(ClosedPanelIdentity),
	}),
);
const reportPattern =
	/<subagent_result name="([^"]*)" state="(?:done|blocked)" pane="([^"]*)">([\s\S]*?)<\/subagent_result>/gu;
const decodeXmlText = (text: string): string =>
	text
		.replaceAll("&quot;", '"')
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&amp;", "&");

// Normalize presentation, not words or code operators. Partial or changed reports
// must stay available. In particular, do not use fuzzy word-overlap to discard data.
const normalizeReportText = (text: string): string => {
	let fenced = false;
	return stripVTControlCharacters(text)
		.split(/\r?\n/u)
		.map((line) => {
			if (/^\s*(```|~~~)/u.test(line)) {
				fenced = !fenced;
				return "";
			}
			if (fenced) return line;
			return line
				.replace(/^\s*#{1,6}\s+/u, "")
				.replace(/^\s*[-*+•]\s+/u, "- ")
				.replace(/\*\*([^*\n]+)\*\*/gu, "$1")
				.replace(/`([^`\n]+)`/gu, "$1");
		})
		.join(" ")
		.replaceAll(/\s+/gu, " ")
		.trim();
};

/** Remove already-consumed result copies while preserving unread reports and archived originals. */
export const refreshSubagentResultGuidance = (
	messages: ReadonlyArray<ContextEvent["messages"][number]>,
	branch: ReadonlyArray<SessionEntry> = [],
): ContextEvent["messages"] => {
	const consumed = new Set<string>();
	const closedPanels = new Set<string>();
	const epochs = new Map<string, number>();
	const inspections = new Map<string, Array<{ epoch: number; text: string }>>();
	const messageEpochs = new Map<ContextEvent["messages"][number], Map<string, number>>();
	const collectReceipt = (message: ContextEvent["messages"][number]) => {
		if (message.role !== "toolResult" || message.toolName !== "herdr_subagent" || message.isError)
			return;
		const inspection = decodeInspection(message.details);
		if (Option.isSome(inspection))
			for (const id of inspection.value.consumedCompletions ?? []) consumed.add(id);
	};
	// Receipts live on the active branch, so reload/compaction do not resurrect a
	// consumed notification. Other branches cannot suppress this branch's reports.
	for (const entry of branch) if (entry.type === "message") collectReceipt(entry.message);
	for (const message of messages) {
		collectReceipt(message);
		if (message.role === "custom" && message.customType === CUSTOM_MESSAGE_TYPE)
			messageEpochs.set(message, new Map(epochs));
		if (message.role !== "toolResult" || message.toolName !== "herdr_subagent" || message.isError)
			continue;
		const work = decodeNewWork(message.details);
		if (Option.isSome(work)) {
			const identity = work.value.entry ?? work.value.resolved;
			if (identity?.paneId) {
				const key = panelKey(escapeXmlText(identity.name), escapeXmlText(identity.paneId));
				epochs.set(key, (epochs.get(key) ?? 0) + 1);
			}
		}
		const inspected = decodeInspection(message.details);
		if (Option.isSome(inspected) && inspected.value.resolved.paneId) {
			const identity = inspected.value.resolved;
			const key = panelKey(
				escapeXmlText(identity.name),
				escapeXmlText(inspected.value.resolved.paneId),
			);
			const text = normalizeReportText(
				message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
			);
			inspections.set(key, [
				...(inspections.get(key) ?? []),
				{ epoch: epochs.get(key) ?? 0, text },
			]);
		}
		const closed = decodeClosedAction(message.details);
		if (Option.isSome(closed))
			for (const identity of [closed.value.entry, closed.value.resolved]) {
				if (identity?.paneId)
					closedPanels.add(panelKey(escapeXmlText(identity.name), escapeXmlText(identity.paneId)));
			}
	}

	const seen = new Set<string>();
	return messages.flatMap((message) => {
		if (
			message.role !== "custom" ||
			message.customType !== CUSTOM_MESSAGE_TYPE ||
			typeof message.content !== "string"
		)
			return [message];
		let blocks = 0;
		let remaining = 0;
		const removedPanels = new Set<string>();
		const originalContent = message.content;
		let content = originalContent.replace(
			reportPattern,
			(block: string, name: string, paneId: string, body: string) => {
				blocks++;
				const key = panelKey(name, paneId);
				const encodedId = /<completion_id>([\s\S]*?)<\/completion_id>/u.exec(body)?.[1];
				const id = encodedId === undefined ? undefined : decodeXmlText(encodedId);
				const payload =
					/<(?:final_message|pane_tail)>([\s\S]*?)<\/(?:final_message|pane_tail)>/u.exec(body)?.[1];
				const expected = payload === undefined ? "" : normalizeReportText(decodeXmlText(payload));
				// Old queued envelopes have no completion ID. Be conservative: only an
				// entire matching report in the same send/spawn interval counts as read.
				const alreadyVisible =
					expected.length > 0 &&
					(inspections.get(key) ?? []).some(
						(inspection) =>
							inspection.epoch === (messageEpochs.get(message)?.get(key) ?? 0) &&
							inspection.text.includes(expected),
					);
				if ((id && (consumed.has(id) || seen.has(id))) || (!id && alreadyVisible)) {
					removedPanels.add(key);
					return "";
				}
				if (id) seen.add(id);
				remaining++;
				if (
					id &&
					alreadyVisible &&
					!originalContent.includes(
						`<required_action tool="herdr_subagent" action="inspect" target="${name}" pane="${paneId}">`,
					)
				) {
					// This completion was not known when inspection started. Preserve its
					// new identity/state, but reference the report text already in context.
					return block.replace(
						/<final_message>[\s\S]*?<\/final_message>/u,
						"<report_already_visible>The complete final report text is already present in an inspection result in this context. Use that text; this notification confirms this completion.</report_already_visible>",
					);
				}
				return block;
			},
		);
		if (blocks > 0 && remaining === 0) return [];
		if (blocks !== remaining)
			content = content.replace(
				/(<subagent_result_group\b[^>]*\bdelivered=")\d+("[^>]*>)/u,
				(_match: string, prefix: string, suffix: string) => `${prefix}${remaining}${suffix}`,
			);
		content = content.replace(
			/<required_action tool="herdr_subagent" action="inspect" target="([^"]*)" pane="([^"]*)">[\s\S]*?<\/required_action>/gu,
			(directive: string, name: string, paneId: string) =>
				removedPanels.has(panelKey(name, paneId))
					? ""
					: closedPanels.has(panelKey(name, paneId))
						? `<subagent_panel_closed name="${name}" pane="${paneId}">\nThis panel was already closed. Use the report above only if its findings are still needed. Do not inspect or respawn this subagent because of this delayed notification. If the report was already incorporated, no further action is needed.\n</subagent_panel_closed>`
						: directive,
		);
		return [content === message.content ? message : { ...message, content }];
	});
};

const stateVerb = (state: NotificationState): string =>
	state === "blocked" ? "needs attention" : "finished";

const requiredActionFor = (notification: {
	readonly name: string;
	readonly paneId: string;
	readonly state: NotificationState;
	readonly observed?: NotificationObserved;
	readonly reportKind?: "final" | "sample";
}): string => {
	if (notification.observed === "rpc" && notification.reportKind !== "sample") {
		return `<result_guidance>Use the final report above to continue the parent task. It is the completed subagent response, not a progress sample. Inspect the pane only if you need missing detail or a separate verification. Do not reread or acknowledge a report already used.</result_guidance>`;
	}
	const escapedName = escapeXmlText(notification.name);
	const nextStep =
		notification.state === "blocked"
			? "Evaluate the blocker, then use herdr_subagent send or focus to unblock it when possible. Otherwise, report the blocker to the user."
			: "Evaluate the result, then use the findings to continue the parent task. Do not duplicate the subagent's completed work.";
	return `<required_action tool="herdr_subagent" action="inspect" target="${escapedName}" pane="${escapeXmlText(notification.paneId)}">
If this subagent was already inspected and closed, use the report above without another lookup or respawn. Otherwise, call herdr_subagent with action=inspect and target="${escapedName}". ${nextStep} Do not stop after only acknowledging an unreviewed result.
</required_action>`;
};

const watchedResultBlockFor = (notification: WatchedNotification): string => {
	const sourceSummary = summarizeSource(notification.summarySource);
	const observedNote =
		notification.observed === "idle" ? " (observed idle: pane may have been viewed)" : "";
	const summary = `Subagent ${notification.name} ${stateVerb(notification.state)}${observedNote}: ${sourceSummary}`;
	return `<subagent_result name="${escapeXmlText(notification.name)}" state="${notification.state}" pane="${escapeXmlText(notification.paneId)}">
${notification.completionId ? `<completion_id>${escapeXmlText(notification.completionId)}</completion_id>\n` : ""}<summary>${escapeXmlText(summary)}</summary>
<pane_tail>
${escapeXmlText(notification.paneTail)}
</pane_tail>
</subagent_result>`;
};

const externalResultBlockFor = (notification: ExternalNotification): string => {
	const sourceSummary = summarizeSource(notification.summarySource);
	const summary = `Subagent ${notification.name} ${stateVerb(notification.state)}: ${sourceSummary}`;
	return `<subagent_result name="${escapeXmlText(notification.name)}" state="${notification.state}" pane="${escapeXmlText(notification.paneId)}">
${notification.completionId ? `<completion_id>${escapeXmlText(notification.completionId)}</completion_id>\n` : ""}<summary>${escapeXmlText(summary)}</summary>
<final_message>
${escapeXmlText(notification.finalMessage)}
</final_message>
</subagent_result>`;
};

const envelopeFor = (notification: WatchedNotification): string =>
	`${watchedResultBlockFor(notification)}\n\n${requiredActionFor(notification)}`;

const externalEnvelopeFor = (notification: ExternalNotification): string =>
	`${externalResultBlockFor(notification)}\n\n${requiredActionFor({ ...notification, observed: "rpc" })}`;

const groupGuidanceFor = (
	deliveries: ReadonlyArray<NotificationDelivery>,
	partial: boolean,
): string => {
	const requiredActions = deliveries.map(requiredActionFor).join("\n");
	const groupStatus = partial
		? "Remaining grouped subagents are still running and will be re-batched."
		: "Use the completed reports to continue the parent task. Inspect only progress samples or missing details.";
	return `${requiredActions}\n${groupStatus}`;
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
	notification: WatchedNotification & { readonly completionId: string },
): NotificationDelivery => ({
	key,
	completionId: notification.completionId,
	reportKind: "sample",
	reportText: notification.paneTail,
	name: notification.name,
	paneId: notification.paneId,
	state: notification.state,
	observed: notification.observed,
	contentBlock: watchedResultBlockFor(notification),
	individualContent: envelopeFor(notification),
});

const externalDeliveryFor = (
	key: string,
	notification: ExternalNotification & { readonly completionId: string },
): NotificationDelivery => ({
	key,
	completionId: notification.completionId,
	reportKind: notification.reportKind,
	reportText: notification.finalMessage,
	name: notification.name,
	paneId: notification.paneId,
	state: notification.state,
	observed: "rpc",
	contentBlock: externalResultBlockFor(notification),
	individualContent: externalEnvelopeFor(notification),
});

const waitForNotificationState: (
	notification: ArmedNotification,
) => Effect.Effect<ObservedState | ExternalNotificationResult, never, NotificationRequirements> =
	Effect.fnUntraced(function* (notification) {
		let consecutiveSettled = 0;
		let firstSettledAt: number | undefined;
		let observedWorking = false;

		const poll: Effect.Effect<
			ObservedState | ExternalNotificationResult,
			never,
			NotificationRequirements
		> = Effect.suspend(() =>
			Effect.gen(function* () {
				if (notification.completionSource === "rpc") {
					const persisted = yield* takePersistedSubagentCompletion(notification.name);
					if (persisted && persisted.sentAtMs >= (notification.acceptResultsSinceMs ?? 0)) {
						return {
							status: persisted.status,
							finalMessage: persisted.finalMessage,
							sentAtMs: persisted.sentAtMs,
							completionId: persisted.completionId,
							armId: persisted.armId,
						};
					}
				}
				const agent = yield* liveAgent(notification.paneId).pipe(
					Effect.catch(() => Effect.succeed(undefined)),
				);
				const status = agent?.agent_status ?? "unknown";
				if (status === "working") {
					observedWorking = true;
					consecutiveSettled = 0;
					firstSettledAt = undefined;
				} else if (
					notification.completionSource === "rpc" &&
					(status === "done" || status === "idle")
				) {
					// Herdr can briefly report a terminal pane status between a length-limited response
					// and Pi's automatic compaction retry. When this subagent has a direct result socket,
					// only agent_settled can complete the watcher. Polling remains active for blockers.
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
	});

const readPaneTail = (paneId: string): Effect.Effect<string, never, NotificationRequirements> =>
	readPane(paneId, "recent-unwrapped", NOTIFICATION_TAIL_LINES).pipe(
		Effect.map((outcome) => truncateForModel(outcome.text, NOTIFICATION_TAIL_LINES).text),
		Effect.catch(() => Effect.succeed("[pane tail unavailable]")),
	);

const watchSubagent: (
	notification: ArmedNotification,
) => Effect.Effect<WatchCompletion, never, NotificationRequirements> = Effect.fnUntraced(
	function* (notification) {
		const observed = yield* waitForNotificationState(notification);
		if (typeof observed !== "string") {
			return {
				name: notification.name,
				result: observed,
			};
		}
		const paneTail = yield* readPaneTail(notification.paneId);
		return {
			notification: {
				...notification,
				state: observed === "blocked" ? "blocked" : "done",
				observed,
				paneTail,
			},
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
				{ deliverAs: "steer", triggerTurn: true },
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
				{ deliverAs: "steer", triggerTurn: true },
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
	const deliveredCompletionIds = new Set<string>();
	const deliveredArmIds = new Set<string>();
	const pendingExternal = new Map<string, ExternalNotificationResult[]>();
	const readyReports = new Map<string, NotificationDelivery>();
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
		pendingExternal.delete(key);
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
		readyReports.set(panelKey(delivery.name, delivery.paneId), delivery);
		if (readyReports.size > MAX_TRACKED_DELIVERED_ARMS) {
			const oldest = readyReports.keys().next();
			if (!oldest.done) readyReports.delete(oldest.value);
		}
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

	const completionIdentity = (name: string, result: ExternalNotificationResult): string =>
		result.completionId ?? `legacy:${name}:${result.sentAtMs}:${result.status}`;

	const rememberDeliveredArm = (armId: string): void => {
		deliveredArmIds.add(armId);
		if (deliveredArmIds.size <= MAX_TRACKED_DELIVERED_ARMS) {
			return;
		}
		const oldest = deliveredArmIds.values().next();
		if (!oldest.done) {
			deliveredArmIds.delete(oldest.value);
		}
	};

	const queuePendingExternal = (key: string, result: ExternalNotificationResult): void => {
		const identity = completionIdentity(key, result);
		const pending = pendingExternal.get(key) ?? [];
		if (pending.some((candidate) => completionIdentity(key, candidate) === identity)) {
			return;
		}
		pendingExternal.set(key, [...pending, result].slice(-32));
	};

	const processExternalResult = (name: string, result: ExternalNotificationResult): boolean => {
		const key = watcherKey(name);
		const identity = completionIdentity(name, result);
		if (deliveredCompletionIds.has(identity)) {
			return false;
		}
		const slot = watchers.get(key);
		if (!slot) {
			queuePendingExternal(key, result);
			return false;
		}
		if (result.sentAtMs < slot.armedAtMs) {
			return false;
		}
		if (result.armId && slot.acceptedArmIds.size > 0 && !slot.acceptedArmIds.has(result.armId)) {
			queuePendingExternal(key, result);
			return false;
		}
		deliveredCompletionIds.add(identity);
		if (result.armId) {
			rememberDeliveredArm(result.armId);
		}
		slot.controller.abort();
		const report = truncateForModel(result.finalMessage);
		processCompletion(
			externalDeliveryFor(key, {
				completionId: identity,
				name: slot.name,
				paneId: slot.paneId,
				summarySource: slot.summarySource,
				state: result.status,
				finalMessage: report.text,
				reportKind: report.truncated ? "sample" : "final",
			}),
		);
		return true;
	};

	const startWatcher = (slot: WatcherSlot, notification: ArmedNotification): void => {
		runPromise(watchSubagent(notification), { signal: slot.controller.signal })
			.then((completion) => {
				if (watchers.get(slot.key) !== slot) {
					return;
				}
				if (completion.result && completion.name) {
					const consumed = processExternalResult(completion.name, completion.result);
					if (!consumed && watchers.get(slot.key) === slot) {
						startWatcher(slot, notification);
					}
					return;
				}
				if (completion.notification) {
					for (const armId of slot.acceptedArmIds) {
						rememberDeliveredArm(armId);
					}
					processCompletion(
						watchedDeliveryFor(slot.key, {
							...completion.notification,
							completionId: `poll:${notification.expectedArmId ?? slot.armedAtMs}:${slot.paneId}:${slot.name}`,
						}),
					);
				}
			})
			.catch(() => {
				if (watchers.get(slot.key) === slot) {
					watchers.delete(slot.key);
					removeKeyFromCurrentBatch(slot.key);
					removeKeyFromGroup(slot.key);
				}
			});
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
			pendingExternal.delete(key);
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
				armedAtMs: notification.acceptResultsSinceMs ?? notificationClock.nowMillis(),
				acceptedArmIds: new Set(notification.expectedArmId ? [notification.expectedArmId] : []),
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
			const armedNotification: ArmedNotification = {
				...notification,
				acceptResultsSinceMs: slot.armedAtMs,
			};
			startWatcher(slot, armedNotification);
			const pending = pendingExternal.get(key) ?? [];
			pendingExternal.delete(key);
			for (let index = 0; index < pending.length; index += 1) {
				const result = pending[index];
				if (!result) {
					continue;
				}
				if (processExternalResult(notification.name, result)) {
					for (const remaining of pending.slice(index + 1)) {
						queuePendingExternal(key, remaining);
					}
					break;
				}
			}
		},
		acceptArm(target, armId) {
			let accepted = false;
			for (const slot of watchers.values()) {
				if (slot.name === target || slot.paneId === target) {
					slot.acceptedArmIds.add(armId);
					accepted = true;
				}
			}
			return accepted;
		},
		hasDeliveredArm(armId) {
			return deliveredArmIds.has(armId);
		},
		deliverExternal(name, result) {
			processExternalResult(name, result);
		},
		beginInspection() {
			// Capture the latest known completion per pane before asynchronous I/O.
			// Identical text in an older or later task is not a read receipt for it.
			const available = [...readyReports.values()];
			return (name, paneId, text) => {
				const inspection = normalizeReportText(text);
				const consumed: string[] = [];
				for (const report of available) {
					if (report.name !== name || report.paneId !== paneId || report.reportKind !== "final")
						continue;
					const expected = normalizeReportText(report.reportText);
					if (!expected || !inspection.includes(expected)) continue;
					consumed.push(report.completionId);
					const groupId = keyToGroup.get(report.key);
					const group = groupId ? groups.get(groupId) : undefined;
					if (group?.completed.get(report.key)?.completionId === report.completionId)
						removeKeyFromGroup(report.key);
				}
				return consumed;
			};
		},
		cancel(target) {
			if (!target) {
				return;
			}
			const matchingKeys = new Set<string>();
			for (const slot of watchers.values()) {
				if (slot.name === target || slot.paneId === target) {
					matchingKeys.add(slot.key);
				}
			}
			for (const group of groups.values()) {
				for (const delivery of group.completed.values()) {
					if (delivery.name === target || delivery.paneId === target) {
						matchingKeys.add(delivery.key);
					}
				}
			}
			for (const key of matchingKeys) {
				cancelKey(key);
			}
			pendingExternal.delete(watcherKey(target));
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
			deliveredCompletionIds.clear();
			deliveredArmIds.clear();
			pendingExternal.clear();
			readyReports.clear();
		},
	};

	return manager;
};
