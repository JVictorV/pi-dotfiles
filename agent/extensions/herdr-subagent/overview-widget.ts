import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
	currentPane,
	decodeHerdrJson,
	isHerdrSubagentSession,
	isRunningInsideHerdr,
} from "./herdr-cli";
import { buildOverview, type Overview, type OverviewTheme, renderOverview } from "./overview";
import { decodeAgentListResponse } from "./schemas";
import { listEntries } from "./store";
import type { RegistryEntry } from "./types";

const WIDGET_ID = "herdr-subagents";

/** Columns of horizontal inset between the background edge and the content. */
const WIDGET_PAD_X = 1;

/** Minimal widget component shape returned to `ctx.ui.setWidget`. */
interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

/**
 * Theme surface for the widget chrome: overview foreground roles plus the
 * background paint used to give the widget a card-like block, matching the
 * backgrounds pi draws behind tool calls and custom messages.
 *
 * pi's `Theme` satisfies this structurally.
 */
export interface OverviewWidgetTheme extends OverviewTheme {
	/** Paint `text` with the background color for `role`. */
	bg(role: "customMessageBg", text: string): string;
}

/**
 * Build a themed widget component factory for an overview snapshot.
 *
 * `render` is stateless: lines are computed on every call from the live theme
 * and the current wall clock, so theme switches recolor immediately and
 * elapsed times age between polls on any TUI repaint.
 *
 * @param overview - Overview snapshot to render.
 * @returns A factory suitable for the component form of `ctx.ui.setWidget`.
 */
const overviewWidget =
	(overview: Overview) =>
	(_tui: unknown, theme: OverviewWidgetTheme): WidgetComponent => ({
		render(width) {
			const inset = " ".repeat(WIDGET_PAD_X);
			const blank = theme.bg("customMessageBg", " ".repeat(width));
			const body = renderOverview(overview, theme, { nowMs: Date.now() }).map((line) => {
				const clipped = truncateToWidth(inset + line, width);
				const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
				return theme.bg("customMessageBg", padded);
			});
			return [blank, ...body, blank];
		},
		invalidate() {},
	});
const DEFAULT_ACTIVE_POLL_MS = 1_000;
const DEFAULT_IDLE_POLL_MS = 15_000;

type OverviewWidgetRequirements = ChildProcessSpawner | FileSystem | Path;
type RunPromise = <A>(effect: Effect.Effect<A, unknown, OverviewWidgetRequirements>) => Promise<A>;

const entriesForOwner = (
	entries: ReadonlyArray<RegistryEntry>,
	ownerPaneId: string | undefined,
): ReadonlyArray<RegistryEntry> =>
	ownerPaneId ? entries.filter((entry) => entry.ownerPaneId === ownerPaneId) : entries;

/** Poll interval overrides for the overview widget. */
export interface OverviewWidgetOptions {
	/** Milliseconds between polls while registry entries are present. */
	readonly pollMs?: number;
	/** Milliseconds between polls while idle or after poll errors. */
	readonly idlePollMs?: number;
}

/** Handle for nudging the registered overview widget outside its poll cadence. */
export interface OverviewWidgetHandle {
	/**
	 * Refresh the widget immediately instead of waiting for the next poll.
	 *
	 * Called after registry-mutating tool actions (spawn/send/close) so the
	 * widget appears without waiting out the 15s idle cadence. No-op when no
	 * widget session is active.
	 */
	poke(): void;
}

/**
 * Register the ambient herdr subagent overview widget for orchestrator TUI sessions.
 *
 * @param pi - Extension API used for lifecycle hooks and widget updates.
 * @param runPromise - Runtime runner with the herdr_subagent Node layers already provided.
 * @param options - Optional poll interval overrides; defaults to 1s active and 15s idle/error.
 * @returns A handle for immediate refreshes after registry mutations.
 */
export const registerOverviewWidget = (
	pi: ExtensionAPI,
	runPromise: RunPromise,
	options?: OverviewWidgetOptions,
): OverviewWidgetHandle => {
	const pollMs = options?.pollMs ?? DEFAULT_ACTIVE_POLL_MS;
	const idlePollMs = options?.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
	if (typeof pi.on !== "function") {
		return { poke() {} };
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let currentToken: object | undefined;
	let clearWidget: (() => void) | undefined;
	let pokeActive: (() => void) | undefined;
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
		const ownerPaneId = runPromise(
			currentPane().pipe(
				Effect.map((pane) => pane.pane_id),
				Effect.catch(() => Effect.succeed(undefined)),
			),
		).catch(() => undefined);

		// Epoch guard: a poke restarts the loop immediately; bumping the epoch
		// turns any in-flight tick's trailing schedule() into a no-op so two
		// timer chains never run concurrently.
		let epoch = 0;

		const schedule = (delayMs: number, tickEpoch: number): void => {
			if (currentToken !== token || tickEpoch !== epoch) {
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
			const tickEpoch = epoch;
			ownerPaneId
				.then((sessionOwnerPaneId) =>
					runPromise(
						Effect.gen(function* () {
							const entries = entriesForOwner(yield* listEntries, sessionOwnerPaneId);
							if (entries.length === 0) {
								return { entries, agents: [] };
							}
							const response = yield* decodeHerdrJson(["agent", "list"], decodeAgentListResponse);
							return { entries, agents: response.result.agents };
						}),
					),
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
					ctx.ui.setWidget(
						WIDGET_ID,
						overview.rows.length > 0 ? overviewWidget(overview) : undefined,
					);
					return pollMs;
				})
				.catch(() => idlePollMs)
				.then((delayMs) => schedule(delayMs, tickEpoch));
		};

		pokeActive = () => {
			if (currentToken !== token) {
				return;
			}
			epoch += 1;
			stopTimer();
			tick();
		};

		stopTimer();
		tick();
	});

	pi.on("session_shutdown", () => {
		currentToken = undefined;
		stopTimer();
		pokeActive = undefined;
		previousKinds.clear();
		clearWidget?.();
		clearWidget = undefined;
	});

	return {
		poke() {
			pokeActive?.();
		},
	};
};
