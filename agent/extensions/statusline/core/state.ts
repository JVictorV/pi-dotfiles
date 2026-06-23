import { Context, Effect, SynchronizedRef } from "effect";

/** Typed key for one feature-owned status-line state slice. */
export type StatusLineStateKey<A> = {
	readonly id: string;
	readonly initial: A;
	equals(left: A, right: A): boolean;
};

/** Current feature-owned state slices read by status-line segments during rendering. */
export type StatusLineSnapshot = ReadonlyMap<string, unknown>;

/** Create a typed state key for a status-line feature. */
export function makeStatusLineStateKey<A>(input: StatusLineStateKey<A>): StatusLineStateKey<A> {
	return input;
}

/** Read a feature state slice from a snapshot, falling back to the feature's initial state. */
export function getStatusLineState<A>(snapshot: StatusLineSnapshot, key: StatusLineStateKey<A>): A {
	const value = snapshot.get(key.id);
	if (value === undefined) return key.initial;
	// oxlint-disable-next-line effect/no-type-casting -- SAFETY: StatusLineStateStore writes values through the same typed StatusLineStateKey id; missing values fall back to key.initial.
	return value as A;
}

/** Store API used by status-line features and render code. */
export type StatusLineStateStoreService = {
	readonly get: Effect.Effect<StatusLineSnapshot>;
	snapshotUnsafe(): StatusLineSnapshot;
	set<A>(key: StatusLineStateKey<A>, value: A): Effect.Effect<boolean>;
	update<A>(key: StatusLineStateKey<A>, derive: (previous: A) => A): Effect.Effect<boolean>;
};

/** Effect service tag for the status-line state store. */
export class StatusLineStateStore extends Context.Service<
	StatusLineStateStore,
	{
		readonly get: Effect.Effect<StatusLineSnapshot>;
		snapshotUnsafe(): StatusLineSnapshot;
		set<A>(key: StatusLineStateKey<A>, value: A): Effect.Effect<boolean>;
		update<A>(key: StatusLineStateKey<A>, derive: (previous: A) => A): Effect.Effect<boolean>;
	}
>()("pi/statusline/StatusLineStateStore") {}

/** Build a status-line state store that notifies when a feature slice actually changes. */
export const makeStatusLineStateStore = (onChange: () => void): StatusLineStateStoreService => {
	const ref = SynchronizedRef.makeUnsafe<StatusLineSnapshot>(new Map());

	const update = <A>(
		key: StatusLineStateKey<A>,
		derive: (previous: A) => A,
	): Effect.Effect<boolean> =>
		SynchronizedRef.modify(ref, (snapshot) => {
			const previous = getStatusLineState(snapshot, key);
			const next = derive(previous);
			const changed = !key.equals(previous, next);
			const nextSnapshot = changed ? new Map(snapshot).set(key.id, next) : snapshot;
			const result: readonly [boolean, StatusLineSnapshot] = [changed, nextSnapshot];
			return result;
		}).pipe(Effect.tap((changed) => (changed ? Effect.sync(onChange) : Effect.succeed(undefined))));

	return {
		get: SynchronizedRef.get(ref),
		snapshotUnsafe: () => SynchronizedRef.getUnsafe(ref),
		set: (key, value) => update(key, () => value),
		update,
	};
};
