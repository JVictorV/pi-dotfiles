import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { Effect, type Fiber, Layer, ManagedRuntime } from "effect";

import type { StatusLineCoreServices, StatusLineFeature } from "./feature";
import { makeStatusLineShell, StatusLineShell, type StatusLineShellService } from "./shell";
import {
	makeStatusLineStateStore,
	StatusLineStateStore,
	type StatusLineSnapshot,
	type StatusLineStateStoreService,
} from "./state";

/** Session-scoped Effect runtime for status-line features. */
export class StatusLineRuntime {
	private readonly features: ReadonlyArray<StatusLineFeature>;
	private readonly shell: StatusLineShellService;
	private readonly store: StatusLineStateStoreService;
	private readonly runtime: ManagedRuntime.ManagedRuntime<StatusLineCoreServices, never>;
	private rootFiber: Fiber.Fiber<void, never> | undefined;
	private requestRender: (() => void) | undefined;
	private disposed = false;

	private constructor(pi: ExtensionAPI, features: ReadonlyArray<StatusLineFeature>) {
		this.features = features;
		this.shell = makeStatusLineShell(pi);
		this.store = makeStatusLineStateStore(() => this.requestRender?.());
		this.runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(StatusLineShell, StatusLineShell.of(this.shell)),
				Layer.succeed(StatusLineStateStore, StatusLineStateStore.of(this.store)),
			),
		);
	}

	/** Create a session-scoped status-line runtime. */
	static make(
		pi: ExtensionAPI,
		_ctx: ExtensionContext,
		features: ReadonlyArray<StatusLineFeature>,
	): StatusLineRuntime {
		return new StatusLineRuntime(pi, features);
	}

	/** Start feature polling fibers. Safe to call more than once. */
	start(): void {
		if (this.disposed || this.rootFiber !== undefined) return;
		const programs = this.features.flatMap((feature) => (feature.start ? [feature.start] : []));
		this.rootFiber = this.runtime.runFork(
			Effect.all(programs, { concurrency: "unbounded", discard: true }),
		);
	}

	/** Refresh feature data after an agent turn. */
	refreshNow(): void {
		this.runAll(this.features.flatMap((feature) => (feature.onTurnEnd ? [feature.onTurnEnd] : [])));
	}

	/** Update features that consume suppressed footer data. */
	updateFooterData(data: ReadonlyFooterDataProvider | undefined): void {
		this.runAll(
			this.features.flatMap((feature) =>
				feature.onFooterData ? [feature.onFooterData(data)] : [],
			),
		);
	}

	/** Run a feature-owned effect on this runtime without blocking the caller. */
	run(program: Effect.Effect<void, never, StatusLineCoreServices>): void {
		if (this.disposed) return;
		this.runtime.runFork(program);
	}

	/** Stop feature fibers and dispose Effect services. Safe to call more than once. */
	async shutdown(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.requestRender = undefined;
		const fiber = this.rootFiber;
		this.rootFiber = undefined;
		fiber?.interruptUnsafe();
		await this.runtime.dispose();
	}

	/** Read the latest state snapshot synchronously for rendering. */
	snapshot(): StatusLineSnapshot {
		return this.store.snapshotUnsafe();
	}

	/** Connect or disconnect the render sink used by state updates. */
	setRenderSink(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	private runAll(
		programs: ReadonlyArray<Effect.Effect<void, never, StatusLineCoreServices>>,
	): void {
		if (programs.length === 0) return;
		this.run(Effect.all(programs, { concurrency: "unbounded", discard: true }));
	}
}
