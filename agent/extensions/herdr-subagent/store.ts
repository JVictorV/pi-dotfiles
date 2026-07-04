import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { Clock, Effect, FileSystem, Option, Predicate, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { ActionRejected, fsFailure, type HerdrFileSystemFailed } from "./errors";
import {
	ensureRuntimeDir,
	getRuntimeDir,
	platformCause,
	readDirectory,
	readTextFile,
	renameFile,
	writeTextFile,
} from "./runtime-files";
import { decodeJsonString, decodeRegistryEntry } from "./schemas";
import type { HerdrAgent } from "./schemas";
import { isSubagentName } from "./subagent-name";
import type { RegistryEntry } from "./types";

/** Directory name that contains per-subagent registry entry files. */
export const ENTRIES_DIR_NAME = "registry";

/** Duration after which a spawn reservation may be taken over by a new spawn. */
export const RESERVATION_STALE_MS = 5 * 60_000;

const REGISTRY_TMP_STALE_MS = 60 * 60 * 1_000;

// Imperative-shell cache: migration is a best-effort runtime side effect, and repeating it on every
// read path would only add filesystem churn. The runtime dir is tracked because tests and reloads can
// reuse this module instance while PI_CODING_AGENT_DIR changes.
let legacyMigrationAttemptedFor: string | undefined;

/** Current wall-clock time formatted for registry metadata. */
export const nowIso: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
	Effect.map((millis) => new Date(millis).toISOString()),
);

const alreadyRegisteredMessage = (name: string): string =>
	`A subagent named ${name} is already registered. Use close first, or pick a different name.`;

const entryDirectory = (): string => path.join(getRuntimeDir(), ENTRIES_DIR_NAME);

const isValidEntryName = (name: string): boolean => isSubagentName(name);

const entryPath = (name: string): string | undefined =>
	isValidEntryName(name) ? path.join(entryDirectory(), `${name}.json`) : undefined;

const isSystemError = (error: PlatformError, tag: string): boolean =>
	Predicate.isTagged(error.reason, tag);

const ensureEntriesDir: Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.gen(function* () {
		yield* ensureRuntimeDir;
		const directory = entryDirectory();
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.makeDirectory(directory, { recursive: true })
			.pipe(Effect.mapError((error) => fsFailure("mkdir", directory, platformCause(error))));
	});

const readDecodedEntryFromPath: (
	filePath: string,
) => Effect.Effect<RegistryEntry | undefined, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (filePath) {
		const text = yield* readTextFile(filePath);
		if (text === undefined) {
			return undefined;
		}
		const json = yield* Effect.result(decodeJsonString(text));
		if (Result.isFailure(json)) {
			return undefined;
		}
		const entry = yield* Effect.result(decodeRegistryEntry(json.success));
		if (Result.isFailure(entry) || !isValidEntryName(entry.success.name)) {
			return undefined;
		}
		return entry.success;
	});

const writeEntryFile: (
	filePath: string,
	entry: RegistryEntry,
) => Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (filePath, entry) {
		yield* writeTextFile(filePath, `${JSON.stringify(entry, null, 2)}\n`);
	},
);

const createEntryFileExclusive: (
	filePath: string,
	entry: RegistryEntry,
) => Effect.Effect<void, PlatformError, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (filePath, entry) {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(filePath, { flag: "wx", mode: 0o600 });
				yield* file.writeAll(new TextEncoder().encode(`${JSON.stringify(entry, null, 2)}\n`));
				yield* file.sync.pipe(Effect.catch(() => Effect.void));
			}),
		);
	},
);

const rejectAlreadyRegistered = (name: string): Effect.Effect<never, ActionRejected> =>
	Effect.fail(new ActionRejected({ message: alreadyRegisteredMessage(name) }));

/** Return the phase for a registry entry, treating absent legacy phase as active. */
export const entryPhase = (entry: RegistryEntry): "reserved" | "active" => entry.phase ?? "active";

/**
 * Read one per-name registry entry.
 *
 * @param name - User-supplied name to look up; invalid names are treated as absent.
 * @returns The decoded entry, or undefined when absent, invalid, or corrupt.
 */
export const readEntry: (
	name: string,
) => Effect.Effect<RegistryEntry | undefined, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (name) {
		const filePath = entryPath(name);
		if (!filePath) {
			return undefined;
		}
		yield* ensureMigrated;
		return yield* readDecodedEntryFromPath(filePath);
	});

/**
 * List all valid per-name registry entries, sorted by subagent name.
 *
 * @returns Decoded entries from the runtime registry directory.
 */
export const listEntries: Effect.Effect<
	ReadonlyArray<RegistryEntry>,
	HerdrFileSystemFailed,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	yield* ensureMigrated;
	yield* sweepStaleRegistryTempFiles;
	const directory = entryDirectory();
	const names = yield* readDirectory(directory);
	const entries: RegistryEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) {
			continue;
		}
		const entry = yield* readDecodedEntryFromPath(path.join(directory, name));
		if (entry) {
			entries.push(entry);
		}
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * Reserve a subagent name by creating its entry file with exclusive filesystem semantics.
 *
 * @param entry - Reservation metadata to persist.
 * @returns Nothing when the reservation was written.
 */
export const reserveEntry: (
	entry: RegistryEntry,
) => Effect.Effect<void, HerdrFileSystemFailed | ActionRejected, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (entry) {
		const filePath = entryPath(entry.name);
		if (!filePath) {
			return yield* rejectAlreadyRegistered(entry.name);
		}
		yield* ensureEntriesDir;
		const createResult = yield* Effect.result(createEntryFileExclusive(filePath, entry));
		if (Result.isSuccess(createResult)) {
			return;
		}
		const createError = createResult.failure;
		if (!isSystemError(createError, "AlreadyExists")) {
			return yield* Effect.fail(fsFailure("open", filePath, platformCause(createError)));
		}

		const existing = yield* readDecodedEntryFromPath(filePath);
		const now = yield* Clock.currentTimeMillis;
		const updatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
		const staleReserved =
			existing &&
			entryPhase(existing) === "reserved" &&
			Number.isFinite(updatedAt) &&
			now - updatedAt > RESERVATION_STALE_MS;
		if (!staleReserved) {
			return yield* rejectAlreadyRegistered(entry.name);
		}

		const fs = yield* FileSystem.FileSystem;
		const takeoverPath = `${filePath}.tmp-takeover-${randomUUID()}`;
		const takeoverResult = yield* Effect.result(fs.rename(filePath, takeoverPath));
		if (Result.isSuccess(takeoverResult)) {
			yield* fs.remove(takeoverPath, { force: true }).pipe(Effect.catch(() => Effect.void));
		} else if (!isSystemError(takeoverResult.failure, "NotFound")) {
			return yield* Effect.fail(
				fsFailure(
					"rename",
					`${filePath} -> ${takeoverPath}`,
					platformCause(takeoverResult.failure),
				),
			);
		}

		const retryResult = yield* Effect.result(createEntryFileExclusive(filePath, entry));
		if (Result.isSuccess(retryResult)) {
			return;
		}
		if (isSystemError(retryResult.failure, "AlreadyExists")) {
			return yield* rejectAlreadyRegistered(entry.name);
		}
		return yield* Effect.fail(fsFailure("open", filePath, platformCause(retryResult.failure)));
	});

/**
 * Atomically replace one per-name registry entry file.
 *
 * @param entry - The entry to persist.
 * @returns Nothing when the entry was written.
 */
export const finalizeEntry: (
	entry: RegistryEntry,
) => Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (entry) {
		const filePath = entryPath(entry.name);
		if (!filePath) {
			return;
		}
		yield* ensureEntriesDir;
		const tempPath = `${filePath}.tmp-${randomUUID()}`;
		yield* writeEntryFile(tempPath, entry);
		yield* renameFile(tempPath, filePath);
	},
);

/**
 * Best-effort hint refresh for one registry entry; failures are intentionally ignored.
 *
 * @param entry - The updated entry hints to persist.
 * @returns Nothing; all filesystem failures are swallowed.
 */
export const updateEntryHints: (
	entry: RegistryEntry,
) => Effect.Effect<void, never, FileSystem.FileSystem> = Effect.fnUntraced(function* (entry) {
	const filePath = entryPath(entry.name);
	if (!filePath) {
		return;
	}
	const fs = yield* FileSystem.FileSystem;
	const bytes = new TextEncoder().encode(`${JSON.stringify(entry, null, 2)}\n`);
	// Hint refresh must not resurrect a concurrently closed entry, so "r+" is the atomic
	// existence check. Torn reads are acceptable here: readEntry/listEntries ignore transiently
	// undecodable files, and reserveEntry treats undecodable state as taken, which is correct for
	// a torn active entry because the name should not be clobbered by a new spawn.
	yield* Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs.open(filePath, { flag: "r+" });
			yield* file.truncate(0);
			yield* file.writeAll(bytes);
			yield* file.sync.pipe(Effect.catch(() => Effect.void));
		}),
	).pipe(Effect.catch(() => Effect.void));
});

/**
 * Remove one per-name registry entry file.
 *
 * @param name - Name whose entry file should be removed; invalid names are ignored.
 * @returns Nothing when the removal completes.
 */
export const removeEntry: (
	name: string,
) => Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (name) {
		const filePath = entryPath(name);
		if (!filePath) {
			return;
		}
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.remove(filePath, { force: true })
			.pipe(Effect.mapError((error) => fsFailure("remove", filePath, platformCause(error))));
	},
);

/**
 * Find a registry entry by name first, then durable terminal id, then volatile pane/tab hints.
 *
 * @param entries - Entries to search.
 * @param target - Name, terminal id, pane id, tab id, or target hint.
 * @returns The matched entry, if any.
 */
export const findEntry = (
	entries: ReadonlyArray<RegistryEntry>,
	target: string,
): RegistryEntry | undefined => {
	const byName = entries.find((entry) => entry.name === target);
	if (byName) {
		return byName;
	}
	const byTerminal = entries.find((entry) => entry.terminalId === target);
	if (byTerminal) {
		return byTerminal;
	}
	return entries.find(
		(entry) => entry.target === target || entry.paneId === target || entry.tabId === target,
	);
};

/** One matched or unmatched registry/live-agent pair. */
export interface MatchedRegistryAgent {
	/** Registry entry attached to the live agent, or an unmatched registry entry. */
	readonly entry?: RegistryEntry;
	/** Live herdr agent attached to the registry entry, or an unmatched foreign live agent. */
	readonly agent?: HerdrAgent;
}

/**
 * Match registry entries to live herdr agents using the status command's legacy priority.
 *
 * Terminal id equality is tried first for every live agent. Pane, tab, and target hints are only
 * used for legacy entries that do not have a durable terminal id. Each registry entry is attached
 * to at most one live agent; unmatched live agents and unmatched entries are preserved in order.
 * This deliberately tightens the old inline status logic: legacy terminal-id-less entries sharing a
 * tab id spread across live agents instead of letting one entry be double-counted.
 *
 * @param entries - Registry entries owned by the herdr_subagent tool.
 * @param agents - Live herdr agents reported by `herdr agent list`.
 * @returns Live-agent matches followed by entries with no matching live agent.
 */
export const matchEntriesToAgents = (
	entries: ReadonlyArray<RegistryEntry>,
	agents: ReadonlyArray<HerdrAgent>,
): ReadonlyArray<MatchedRegistryAgent> => {
	const matchedEntryIndexes = new Set<number>();
	const matches: MatchedRegistryAgent[] = [];

	for (const agent of agents) {
		const terminalId = agent.terminal_id;
		const paneId = agent.pane_id;
		const tabId = agent.tab_id;
		let matchedIndex = terminalId
			? entries.findIndex(
					(entry, index) => !matchedEntryIndexes.has(index) && entry.terminalId === terminalId,
				)
			: -1;

		if (matchedIndex < 0) {
			matchedIndex = entries.findIndex(
				(entry, index) =>
					!matchedEntryIndexes.has(index) &&
					!entry.terminalId &&
					((terminalId !== undefined && entry.target === terminalId) ||
						(paneId !== undefined && entry.paneId === paneId) ||
						(tabId !== undefined && entry.tabId === tabId)),
			);
		}

		if (matchedIndex >= 0) {
			matchedEntryIndexes.add(matchedIndex);
			matches.push({ entry: entries[matchedIndex], agent });
		} else {
			matches.push({ agent });
		}
	}

	entries.forEach((entry, index) => {
		if (!matchedEntryIndexes.has(index)) {
			matches.push({ entry });
		}
	});

	return matches;
};

/** Best-effort one-time migration from the legacy registry.json file into per-name entry files. */
export const migrateLegacyRegistry: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
	function* () {
		const legacyPath = path.join(getRuntimeDir(), "registry.json");
		const textResult = yield* Effect.result(readTextFile(legacyPath));
		if (Result.isFailure(textResult) || textResult.success === undefined) {
			return;
		}
		const json = yield* Effect.result(decodeJsonString(textResult.success));
		if (Result.isFailure(json) || !isLegacyRegistry(json.success)) {
			return;
		}
		let allValidEntriesMigrated = true;
		for (const value of Object.values(json.success.entries)) {
			const decoded = yield* Effect.result(decodeRegistryEntry(value));
			if (Result.isFailure(decoded) || !isValidEntryName(decoded.success.name)) {
				continue;
			}
			const filePath = entryPath(decoded.success.name);
			if (!filePath) {
				continue;
			}
			const existing = yield* Effect.result(readTextFile(filePath));
			if (Result.isFailure(existing)) {
				allValidEntriesMigrated = false;
				continue;
			}
			if (existing.success !== undefined) {
				continue;
			}
			const written = yield* Effect.result(finalizeEntry(decoded.success));
			if (Result.isFailure(written)) {
				allValidEntriesMigrated = false;
			}
		}
		if (allValidEntriesMigrated) {
			yield* renameFile(legacyPath, `${legacyPath}.migrated`).pipe(Effect.catch(() => Effect.void));
		}
	},
).pipe(Effect.catch(() => Effect.void));

const ensureMigrated: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(function* () {
	const runtimeDir = getRuntimeDir();
	if (legacyMigrationAttemptedFor === runtimeDir) {
		return;
	}
	yield* migrateLegacyRegistry;
	legacyMigrationAttemptedFor = runtimeDir;
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isLegacyRegistry = (
	value: unknown,
): value is { readonly version: 1; readonly entries: Record<string, unknown> } =>
	isRecord(value) && value.version === 1 && isRecord(value.entries);

const sweepStaleRegistryTempFiles: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
	function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = entryDirectory();
		const names = yield* fs.readDirectory(directory).pipe(Effect.result);
		if (Result.isFailure(names)) {
			return;
		}
		const now = yield* Clock.currentTimeMillis;
		for (const name of names.success) {
			if (!name.includes(".tmp-")) {
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
	},
).pipe(Effect.catch(() => Effect.void));
