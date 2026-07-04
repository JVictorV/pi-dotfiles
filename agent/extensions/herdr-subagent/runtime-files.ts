import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { fsFailure, type HerdrFileSystemFailed } from "./errors";

// Keep node:path for deterministic path math only; filesystem effects use the Effect FileSystem service.
export const getRuntimeDir = (): string => path.join(getAgentDir(), "herdr-subagents");

export const getRegistryPath = (): string => path.join(getRuntimeDir(), "registry.json");

export const platformCause = (error: PlatformError): unknown => error.reason.cause ?? error;

const isNotFound = (error: PlatformError): boolean => Predicate.isTagged(error.reason, "NotFound");

export const readTextFile: (
	filePath: string,
) => Effect.Effect<string | undefined, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (filePath) {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.readFileString(filePath, "utf8")
			.pipe(
				Effect.catch((error) =>
					isNotFound(error)
						? Effect.succeed(undefined)
						: Effect.fail(fsFailure("readFile", filePath, platformCause(error))),
				),
			);
	});

export const readDirectory: (
	directory: string,
) => Effect.Effect<ReadonlyArray<string>, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.fnUntraced(function* (directory) {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.readDirectory(directory)
			.pipe(
				Effect.catch((error) =>
					isNotFound(error)
						? Effect.succeed<ReadonlyArray<string>>([])
						: Effect.fail(fsFailure("readdir", directory, platformCause(error))),
				),
			);
	});

export const isDirectory: (
	directory: string,
) => Effect.Effect<boolean, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (directory) {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.stat(directory).pipe(
			Effect.map((stat) => stat.type === "Directory"),
			Effect.catch((error) =>
				isNotFound(error)
					? Effect.succeed(false)
					: Effect.fail(fsFailure("stat", directory, platformCause(error))),
			),
		);
	},
);

export const ensureRuntimeDir: Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> =
	Effect.gen(function* () {
		const directory = getRuntimeDir();
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.makeDirectory(directory, { recursive: true })
			.pipe(Effect.mapError((error) => fsFailure("mkdir", directory, platformCause(error))));
	});

export const writeTextFile = Effect.fnUntraced(function* (filePath: string, content: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs
		.writeFileString(filePath, content, { mode: 0o600 })
		.pipe(Effect.mapError((error) => fsFailure("writeFile", filePath, platformCause(error))));
});

export const renameFile: (
	from: string,
	to: string,
) => Effect.Effect<void, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (from, to) {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs
			.rename(from, to)
			.pipe(
				Effect.mapError((error) => fsFailure("rename", `${from} -> ${to}`, platformCause(error))),
			);
	},
);

export const deleteRuntimeFiles: (
	filePaths: ReadonlyArray<string | undefined>,
) => Effect.Effect<void, never, FileSystem.FileSystem> = Effect.fnUntraced(function* (filePaths) {
	const fs = yield* FileSystem.FileSystem;
	for (const filePath of filePaths) {
		if (!filePath) {
			continue;
		}
		yield* fs.remove(filePath, { force: true }).pipe(Effect.catch(() => Effect.void));
	}
});

const safeFilePart = (value: string): string => {
	const cleaned = value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "subagent";
};

export const writeRuntimeFile: (
	prefix: string,
	name: string,
	content: string,
) => Effect.Effect<string, HerdrFileSystemFailed, FileSystem.FileSystem> = Effect.fnUntraced(
	function* (prefix, name, content) {
		yield* ensureRuntimeDir;
		const filePath = path.join(
			getRuntimeDir(),
			`${prefix}-${safeFilePart(name)}-${randomUUID()}.md`,
		);
		yield* writeTextFile(filePath, content);
		return filePath;
	},
);
