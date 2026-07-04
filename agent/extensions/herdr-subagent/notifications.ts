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

type NotificationRequirements = ChildProcessSpawner | FileSystem | Path;
// SAFETY: This boundary mirrors ManagedRuntime.runPromise, which accepts effects with any
// error channel and turns failures into rejected Promises. Watcher internals still model expected
// failures with typed Effect errors before deliberately degrading to never-failing notifications.
type RunPromise = <A>(
	effect: Effect.Effect<A, unknown, NotificationRequirements>,
	options?: { readonly signal?: AbortSignal },
) => Promise<A>;

type NotificationState = "done" | "blocked";

type ObservedState = "done" | "idle" | "blocked";

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

interface WatcherSlot {
	readonly key: string;
	readonly name: string;
	readonly paneId: string;
	readonly controller: AbortController;
}

/** Lifecycle controls for background subagent completion notifications. */
export interface SubagentNotificationManager {
	/** Arm or re-arm one notification watcher for a subagent turn. */
	arm(notification: ArmedNotification): void;
	/** Cancel any watcher matching a subagent name, pane id, or tool target. */
	cancel(target: string | undefined): void;
	/** Cancel all active notification watchers. */
	cancelAll(): void;
}

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

const envelopeFor = (notification: WatchedNotification): string => {
	const sourceSummary = summarizeSource(notification.summarySource);
	const observedNote =
		notification.observed === "idle" ? " (observed idle: pane may have been viewed)" : "";
	const summary = `Subagent ${notification.name} ${stateVerb(notification.state)}${observedNote}: ${sourceSummary}`;
	return `<subagent_result name="${escapeXmlText(notification.name)}" state="${notification.state}" pane="${escapeXmlText(notification.paneId)}">
<summary>${escapeXmlText(summary)}</summary>
<pane_tail>
${escapeXmlText(notification.paneTail)}
</pane_tail>
</subagent_result>

${guidanceFor(notification.state)}`;
};

const waitForNotificationState: (
	notification: ArmedNotification,
) => Effect.Effect<ObservedState, never, NotificationRequirements> = Effect.fnUntraced(
	function* (notification) {
		let consecutiveIdle = 0;
		let firstIdleAt: number | undefined;
		let observedWorking = false;

		const poll: Effect.Effect<ObservedState, never, NotificationRequirements> = Effect.suspend(() =>
			Effect.gen(function* () {
				const agent = yield* liveAgent(notification.paneId);
				const status = agent?.agent_status ?? "unknown";
				if (status === "blocked") {
					return "blocked";
				}
				if (status === "done") {
					return "done";
				}
				if (status === "working") {
					observedWorking = true;
				}
				if (status === "idle") {
					const now = yield* Clock.currentTimeMillis;
					firstIdleAt ??= now;
					consecutiveIdle += 1;
					if (observedWorking && consecutiveIdle >= WATCH_IDLE_CONFIRMATIONS) {
						return "idle";
					}
					if (
						!observedWorking &&
						consecutiveIdle >= WATCH_IDLE_CONFIRMATIONS &&
						now - firstIdleAt >= WATCH_STARTUP_IDLE_STABILITY_MS
					) {
						return "idle";
					}
				} else {
					consecutiveIdle = 0;
					firstIdleAt = undefined;
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

const deliverNotification = (
	pi: ExtensionAPI,
	notification: WatchedNotification,
): Effect.Effect<void, never> =>
	Effect.try({
		try: () => {
			pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: envelopeFor(notification),
					display: true,
					details: {
						name: notification.name,
						paneId: notification.paneId,
						state: notification.state,
						observed: notification.observed,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

/** Create a session-scoped manager for background herdr subagent notifications. */
export const createSubagentNotificationManager = (
	pi: ExtensionAPI,
	runPromise: RunPromise,
): SubagentNotificationManager => {
	const watchers = new Map<string, WatcherSlot>();

	const cancelKey = (key: string): void => {
		const existing = watchers.get(key);
		if (!existing) {
			return;
		}
		existing.controller.abort();
		watchers.delete(key);
	};

	const manager: SubagentNotificationManager = {
		arm(notification) {
			const key = watcherKey(notification.name);
			cancelKey(key);
			const controller = new AbortController();
			const slot: WatcherSlot = {
				key,
				name: notification.name,
				paneId: notification.paneId,
				controller,
			};
			watchers.set(key, slot);
			runPromise(watchSubagent(notification), { signal: controller.signal })
				.then((watched) => {
					if (watchers.get(key) !== slot) {
						return;
					}
					watchers.delete(key);
					Effect.runSync(deliverNotification(pi, watched));
				})
				.catch(() => {
					if (watchers.get(key) === slot) {
						watchers.delete(key);
					}
				});
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
		},
	};

	return manager;
};
