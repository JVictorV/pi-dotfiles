import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { decodeHerdrJson, isHerdrSubagentSession, isRunningInsideHerdr } from "./herdr-cli";
import { buildOverview, renderOverviewLines } from "./overview";
import { decodeAgentListResponse } from "./schemas";
import { listEntries } from "./store";

const WIDGET_ID = "herdr-subagents";
const DEFAULT_ACTIVE_POLL_MS = 2_000;
const DEFAULT_IDLE_POLL_MS = 15_000;

type OverviewWidgetRequirements = ChildProcessSpawner | FileSystem | Path;
type RunPromise = <A>(effect: Effect.Effect<A, unknown, OverviewWidgetRequirements>) => Promise<A>;

/** Poll interval overrides for the overview widget. */
export interface OverviewWidgetOptions {
	/** Milliseconds between polls while registry entries are present. */
	readonly pollMs?: number;
	/** Milliseconds between polls while idle or after poll errors. */
	readonly idlePollMs?: number;
}

/**
 * Register the ambient herdr subagent overview widget for orchestrator TUI sessions.
 *
 * @param pi - Extension API used for lifecycle hooks and widget updates.
 * @param runPromise - Runtime runner with the herdr_subagent Node layers already provided.
 * @param options - Optional poll interval overrides; defaults to 2s active and 15s idle/error.
 */
export const registerOverviewWidget = (
	pi: ExtensionAPI,
	runPromise: RunPromise,
	options?: OverviewWidgetOptions,
): void => {
	const pollMs = options?.pollMs ?? DEFAULT_ACTIVE_POLL_MS;
	const idlePollMs = options?.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
	if (typeof pi.on !== "function") {
		return;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let currentToken: object | undefined;
	let clearWidget: (() => void) | undefined;
	const previousKinds = new Map<string, string>();

	const stopTimer = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || !isRunningInsideHerdr() || isHerdrSubagentSession()) {
			return;
		}

		const token = {};
		currentToken = token;
		clearWidget = () => ctx.ui.setWidget(WIDGET_ID, undefined);
		previousKinds.clear();

		const schedule = (delayMs: number): void => {
			if (currentToken !== token) {
				return;
			}
			timer = setTimeout(() => {
				tick();
			}, delayMs);
			timer.unref();
		};

		const tick = (): void => {
			if (currentToken !== token) {
				return;
			}
			runPromise(
				Effect.gen(function* () {
					const entries = yield* listEntries;
					if (entries.length === 0) {
						return { entries, agents: [] };
					}
					const response = yield* decodeHerdrJson(["agent", "list"], decodeAgentListResponse);
					return { entries, agents: response.result.agents };
				}),
			)
				.then((snapshot): number => {
					if (currentToken !== token) {
						return idlePollMs;
					}
					if (snapshot.entries.length === 0) {
						ctx.ui.setWidget(WIDGET_ID, undefined);
						previousKinds.clear();
						return idlePollMs;
					}

					const overview = buildOverview(snapshot.entries, snapshot.agents, Date.now());
					for (const row of overview.rows) {
						if (row.kind === "blocked" && previousKinds.get(row.name) !== "blocked") {
							ctx.ui.notify(`subagent ${row.name} is blocked`, "warning");
						}
					}
					previousKinds.clear();
					for (const row of overview.rows) {
						previousKinds.set(row.name, row.kind);
					}
					const lines = renderOverviewLines(overview);
					ctx.ui.setWidget(WIDGET_ID, lines.length > 0 ? lines : undefined);
					return pollMs;
				})
				.catch(() => idlePollMs)
				.then(schedule);
		};

		stopTimer();
		tick();
	});

	pi.on("session_shutdown", () => {
		currentToken = undefined;
		stopTimer();
		previousKinds.clear();
		clearWidget?.();
		clearWidget = undefined;
	});
};
