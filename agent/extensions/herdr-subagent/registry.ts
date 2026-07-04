import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { Clock, Effect, FileSystem, Option, Predicate, Result, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { ActionRejected, fsFailure, type HerdrFileSystemFailed } from "./errors";
import {
	ensureRuntimeDir,
	getRegistryPath,
	getRuntimeDir,
	platformCause,
	readTextFile,
	renameFile,
	writeTextFile,
} from "./runtime-files";
import { decodeJsonString, decodeRegistryEntry } from "./schemas";
import type { Registry, RegistryEntry } from "./types";

const registrySemaphore = Semaphore.makeUnsafe(1);
const LOCK_BACKOFF_MS = 50;
// Registry critical sections are normally millisecond-scale. A live holder exceeding
// this local 5s stale window is theoretical; the trade-off lets crashed holders recover.
const LOCK_STALE_MS = 5_000;
const REGISTRY_TMP_STALE_MS = 60 * 60 * 1_000;

interface RegistryLockFile {
	readonly path: string;
	readonly token: string;
}

export const nowIso: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
	Effect.map((millis) => new Date(millis).toISOString()),
);

const emptyRegistry = (): Registry => ({ version: 1, entries: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isSystemError = (error: PlatformError, tag: string): boolean =>
	Predicate.isTagged(error.reason, tag);

const registryParseFailure = (cause: unknown): HerdrFileSystemFailed =>
	fsFailure("parseRegistry", getRegistryPath(), cause);

const parseRegistryText: (text: string) => Effect.Effect<Registry, HerdrFileSystemFailed> =
	Effect.fnUntraced(function* (text) {
		const json = yield* decodeJsonString(text).pipe(Effect.mapError(registryParseFailure));
		if (!isRecord(json) || json.version !== 1 || !isRecord(json.entries)) {
			return yield* Effect.fail(
				registryParseFailure({ reason: "registry JSON does not have version 1 entries object" }),
			);
		}

		const entries: Record<string, RegistryEntry> = {};
		for (const value of Object.values(json.entries)) {
			const decoded = yield* Effect.result(decodeRegistryEntry(value));
			if (Result.isSuccess(decoded)) {
				entries[decoded.success.name] = decoded.success;
			}
		}
		return { version: 1, entries };
	});

export const readRegistry: Effect.Effect<Registry, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.gen(function* () {
		const text = yield* readTextFile(getRegistryPath());
		if (text === undefined) {
			return emptyRegistry();
		}
		return yield* parseRegistryText(text);
	});

export const writeRegistry: (
	registry: Registry,
) => Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (registry) {
		yield* ensureRuntimeDir;
		// Write-then-rename so a concurrent readRegistry never sees a torn file.
		const registryPath = getRegistryPath();
		const tempPath = `${registryPath}.tmp-${randomUUID()}`;
		yield* writeTextFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`);
		yield* renameFile(tempPath, registryPath);
	},
);

const lockPath = (): string => path.join(getRuntimeDir(), "registry.lock");

const lockFileIsStale: (filePath: string) => Effect.Effect<boolean, never, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (filePath) {
		const fs = yield* FileSystem.FileSystem;
		const stat = yield* fs.stat(filePath).pipe(Effect.result);
		if (Result.isFailure(stat)) {
			return false;
		}
		const modifiedAt = Option.getOrNull(stat.success.mtime);
		if (!modifiedAt) {
			return true;
		}
		const now = yield* Clock.currentTimeMillis;
		return now - modifiedAt.getTime() > LOCK_STALE_MS;
	});

const acquireRegistryLockFile: Effect.Effect<
	RegistryLockFile,
	HerdrFileSystemFailed,
	FileSystem.FileSystem
> = Effect.fnUntraced(function* () {
	yield* ensureRuntimeDir;
	const fs = yield* FileSystem.FileSystem;
	const filePath = lockPath();
	const token = randomUUID();

	const attempt: Effect.Effect<RegistryLockFile, HerdrFileSystemFailed, FileSystem.FileSystem> =
		Effect.suspend(() =>
			Effect.gen(function* () {
				const opened = yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(filePath, { flag: "wx", mode: 0o600 });
						yield* file.writeAll(new TextEncoder().encode(`${token}\n`));
						yield* file.sync.pipe(Effect.catch(() => Effect.void));
					}),
				).pipe(Effect.result);
				if (Result.isSuccess(opened)) {
					return { path: filePath, token };
				}

				const error = opened.failure;
				if (isSystemError(error, "AlreadyExists")) {
					if (yield* lockFileIsStale(filePath)) {
						yield* fs.remove(filePath, { force: true }).pipe(Effect.catch(() => Effect.void));
					} else {
						yield* Effect.sleep(LOCK_BACKOFF_MS);
					}
					return yield* attempt;
				}
				return yield* Effect.fail(fsFailure("open", filePath, platformCause(error)));
			}),
		);

	return yield* attempt;
})();

const releaseRegistryLockFile: (
	lock: RegistryLockFile,
) => Effect.Effect<void, never, FileSystem.FileSystem> = Effect.fnUntraced(function* (lock) {
	const fs = yield* FileSystem.FileSystem;
	const currentToken = yield* fs.readFileString(lock.path, "utf8").pipe(Effect.result);
	if (Result.isSuccess(currentToken) && currentToken.success.trim() === lock.token) {
		yield* fs.remove(lock.path, { force: true }).pipe(Effect.catch(() => Effect.void));
	}
});

const sweepStaleRegistryTempFiles: Effect.Effect<void, never, FileSystem.FileSystem> =
	Effect.fnUntraced(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = getRuntimeDir();
		const names = yield* fs.readDirectory(directory).pipe(Effect.result);
		if (Result.isFailure(names)) {
			return;
		}
		const now = yield* Clock.currentTimeMillis;
		for (const name of names.success) {
			if (!name.includes(".tmp-") && !name.startsWith("tmp-")) {
				continue;
			}
			const filePath = path.join(directory, name);
			const stat = yield* fs.stat(filePath).pipe(Effect.result);
			if (Result.isFailure(stat)) {
				continue;
			}
			const modifiedAt = Option.getOrNull(stat.success.mtime);
			if (!modifiedAt || now - modifiedAt.getTime() > REGISTRY_TMP_STALE_MS) {
				yield* fs.remove(filePath, { force: true }).pipe(Effect.catch(() => Effect.void));
			}
		}
	})();

const withRegistryLock = <A, E, R>(
	operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HerdrFileSystemFailed, R | FileSystem.FileSystem> =>
	registrySemaphore.withPermits(1)(
		Effect.acquireUseRelease(
			acquireRegistryLockFile,
			() =>
				Effect.gen(function* () {
					yield* sweepStaleRegistryTempFiles;
					return yield* operation;
				}),
			(lock) => releaseRegistryLockFile(lock),
		),
	);

/**
 * Serialized read-modify-write for the registry with an effectful mutation.
 *
 * @param mutate - Function that receives a fresh copy of entries inside the registry lock.
 * @returns The written registry after the mutation succeeds.
 */
export const mutateRegistryEffect: <E, R>(
	mutate: (
		entries: Record<string, RegistryEntry>,
	) => Effect.Effect<Record<string, RegistryEntry>, E, R>,
) => Effect.Effect<Registry, E | HerdrFileSystemFailed, R | FileSystem.FileSystem> =
	Effect.fnUntraced(function* (mutate) {
		return yield* withRegistryLock(
			Effect.gen(function* () {
				const current = yield* readRegistry;
				const nextEntries = yield* mutate({ ...current.entries });
				const nextRegistry: Registry = { version: 1, entries: nextEntries };
				yield* writeRegistry(nextRegistry);
				return nextRegistry;
			}),
		);
	});

/**
 * Serialized read-modify-write for the registry. Sibling tool calls run in
 * parallel in pi, so every mutation must re-read the current registry inside
 * the lock; snapshotting entries earlier and writing them back would drop
 * concurrent spawns (last writer wins).
 */
export const mutateRegistry: (
	mutate: (entries: Record<string, RegistryEntry>) => Record<string, RegistryEntry>,
) => Effect.Effect<Registry, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (mutate) {
		return yield* mutateRegistryEffect((entries) => Effect.succeed(mutate(entries)));
	},
);

const alreadyRegisteredMessage = (name: string): string =>
	`A subagent named ${name} is already registered. Use close first, or pick a different name.`;

/**
 * Reserve a registry name inside the registry lock before creating herdr resources.
 *
 * @param entry - Placeholder entry keyed by its name.
 * @returns The registry containing the reservation.
 */
export const reserveRegistryEntry = (
	entry: RegistryEntry,
): Effect.Effect<Registry, HerdrFileSystemFailed | ActionRejected, FileSystem.FileSystem> =>
	mutateRegistryEffect((entries) => {
		if (entries[entry.name]) {
			return Effect.fail(new ActionRejected({ message: alreadyRegisteredMessage(entry.name) }));
		}
		return Effect.succeed({ ...entries, [entry.name]: entry });
	});

/**
 * Replace a reserved registry entry with the finalized spawn metadata.
 *
 * @param entry - Final registry entry for the spawned subagent.
 * @returns The registry containing the finalized entry.
 */
export const finalizeRegistryEntry = (
	entry: RegistryEntry,
): Effect.Effect<Registry, HerdrFileSystemFailed, FileSystem.FileSystem> =>
	mutateRegistry((entries) => ({ ...entries, [entry.name]: entry }));

export const removeRegistryEntry = (
	name: string,
): Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> =>
	mutateRegistry((entries) => {
		delete entries[name];
		return entries;
	}).pipe(Effect.asVoid);

export const findRegistryEntry = (
	registry: Registry,
	target: string,
): RegistryEntry | undefined => {
	const byName = registry.entries[target];
	if (byName) {
		return byName;
	}
	return Object.values(registry.entries).find(
		(entry) =>
			entry.target === target ||
			entry.terminalId === target ||
			entry.paneId === target ||
			entry.tabId === target,
	);
};
