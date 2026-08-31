import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

const INSTRUCTIONS_FILE_NAME = "AGENTS.md";

const StorageOperation = Schema.Literals(["locate", "read", "write", "remove"]);
type StorageOperation = typeof StorageOperation.Type;

/** A classified filesystem failure while managing private project instructions. */
export class ProjectInstructionsStorageError extends Schema.TaggedErrorClass<ProjectInstructionsStorageError>()(
	"ProjectInstructionsStorageError",
	{
		operation: StorageOperation,
		path: Schema.String,
		reason: Schema.String,
		cause: Schema.Defect(),
	},
) {
	override get message(): string {
		return this.reason;
	}
}

/** The external location assigned to one project. */
export type ProjectInstructionsLocation = {
	/** The canonical root used for project-relative behavior. */
	readonly projectRoot: string;
	/** The private directory for this project's instruction file. */
	readonly directory: string;
	/** The private `AGENTS.md` path injected into Pi's system prompt. */
	readonly instructionsFile: string;
};

type GitMarker = {
	readonly projectRoot: string;
	readonly marker: string;
};

type ProjectIdentity = {
	readonly projectRoot: string;
	readonly projectName: string;
	readonly key: string;
};

const platformCause = (error: PlatformError): unknown => error.reason.cause ?? error;
const isNotFound = (error: PlatformError): boolean => Predicate.isTagged(error.reason, "NotFound");

const storageError = (
	operation: StorageOperation,
	path: string,
	cause: unknown,
	detail?: string,
): ProjectInstructionsStorageError =>
	new ProjectInstructionsStorageError({
		operation,
		path,
		reason: detail ?? `Cannot ${operation} private project instructions at ${path}`,
		cause,
	});

const mapFileSystemError =
	(operation: StorageOperation, path: string) =>
	(error: PlatformError): ProjectInstructionsStorageError =>
		storageError(operation, path, platformCause(error));

const canonicalPath = Effect.fnUntraced(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs
		.realPath(resolve(path))
		.pipe(Effect.mapError(mapFileSystemError("locate", path)));
});

const findGitMarker = Effect.fn("ProjectInstructions.findGitMarker")(function* (cwd: string) {
	const fs = yield* FileSystem.FileSystem;
	let current = yield* canonicalPath(cwd);
	const filesystemRoot = parse(current).root;

	while (true) {
		const marker = join(current, ".git");
		const exists = yield* fs
			.exists(marker)
			.pipe(Effect.mapError(mapFileSystemError("locate", marker)));
		if (exists) return Option.some({ projectRoot: current, marker } satisfies GitMarker);
		if (current === filesystemRoot) return Option.none<GitMarker>();
		current = dirname(current);
	}
});

const readOptionalFile = Effect.fnUntraced(function* (path: string, operation: StorageOperation) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.readFileString(path, "utf8").pipe(
		Effect.map(Option.some),
		Effect.catch((error) =>
			isNotFound(error)
				? Effect.succeed(Option.none<string>())
				: Effect.fail(mapFileSystemError(operation, path)(error)),
		),
	);
});

const resolveGitIdentityPath = Effect.fn("ProjectInstructions.resolveGitIdentityPath")(function* (
	projectRoot: string,
	marker: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const symlinkTarget = yield* fs.readLink(marker).pipe(Effect.option);
	if (Option.isSome(symlinkTarget)) {
		return yield* Effect.fail(
			storageError(
				"locate",
				marker,
				symlinkTarget.value,
				`Symbolic .git markers are not supported: ${marker}`,
			),
		);
	}

	const markerInfo = yield* fs
		.stat(marker)
		.pipe(Effect.mapError(mapFileSystemError("locate", marker)));

	if (markerInfo.type === "Directory") {
		return yield* fs.realPath(marker).pipe(Effect.mapError(mapFileSystemError("locate", marker)));
	}
	if (markerInfo.type !== "File") {
		return yield* Effect.fail(
			storageError(
				"locate",
				marker,
				markerInfo.type,
				`${marker} is not a Git directory or gitdir file`,
			),
		);
	}

	const markerContent = yield* fs
		.readFileString(marker, "utf8")
		.pipe(Effect.mapError(mapFileSystemError("locate", marker)));
	const match = /^gitdir:\s*(.+?)\s*$/im.exec(markerContent);
	const gitDirectoryValue = match?.[1];
	if (!gitDirectoryValue) {
		return yield* Effect.fail(
			storageError("locate", marker, markerContent, `${marker} does not contain a gitdir entry`),
		);
	}

	const unresolvedGitDirectory = resolve(projectRoot, gitDirectoryValue);
	const gitDirectory = yield* fs
		.realPath(unresolvedGitDirectory)
		.pipe(Effect.mapError(mapFileSystemError("locate", unresolvedGitDirectory)));
	const commonDirectoryFile = join(gitDirectory, "commondir");
	const commonDirectoryValue = yield* readOptionalFile(commonDirectoryFile, "locate");
	if (Option.isNone(commonDirectoryValue)) {
		// A separate Git directory has no reliable backlink to its worktree. Key it
		// by this project's marker so another directory cannot spoof its identity.
		return yield* fs.realPath(marker).pipe(Effect.mapError(mapFileSystemError("locate", marker)));
	}

	const backlinkFile = join(gitDirectory, "gitdir");
	const backlinkValue = yield* readOptionalFile(backlinkFile, "locate");
	if (Option.isNone(backlinkValue) || !backlinkValue.value.trim()) {
		return yield* Effect.fail(
			storageError(
				"locate",
				backlinkFile,
				Option.getOrElse(backlinkValue, () => ""),
				`${gitDirectory} is missing its worktree backlink`,
			),
		);
	}

	const unresolvedBacklink = resolve(gitDirectory, backlinkValue.value.trim());
	const [resolvedBacklink, resolvedMarker] = yield* Effect.all([
		fs
			.realPath(unresolvedBacklink)
			.pipe(Effect.mapError(mapFileSystemError("locate", unresolvedBacklink))),
		fs.realPath(marker).pipe(Effect.mapError(mapFileSystemError("locate", marker))),
	]);
	if (resolvedBacklink !== resolvedMarker) {
		return yield* Effect.fail(
			storageError(
				"locate",
				marker,
				backlinkValue.value,
				`${marker} is not the registered worktree for ${gitDirectory}`,
			),
		);
	}

	const relativeCommonDirectory = commonDirectoryValue.value.trim();
	if (!relativeCommonDirectory) {
		return yield* Effect.fail(
			storageError(
				"locate",
				commonDirectoryFile,
				commonDirectoryValue.value,
				`${commonDirectoryFile} is empty`,
			),
		);
	}

	const unresolvedCommonDirectory = resolve(gitDirectory, relativeCommonDirectory);
	const commonDirectory = yield* fs
		.realPath(unresolvedCommonDirectory)
		.pipe(Effect.mapError(mapFileSystemError("locate", unresolvedCommonDirectory)));
	const relativeMetadataPath = relative(join(commonDirectory, "worktrees"), gitDirectory);
	const metadataIsInsideCommonDirectory =
		relativeMetadataPath.length > 0 &&
		!isAbsolute(relativeMetadataPath) &&
		relativeMetadataPath !== ".." &&
		!relativeMetadataPath.startsWith(`..${sep}`);
	if (!metadataIsInsideCommonDirectory) {
		return yield* Effect.fail(
			storageError(
				"locate",
				gitDirectory,
				commonDirectory,
				`${gitDirectory} is outside ${commonDirectory}'s worktree metadata`,
			),
		);
	}
	return commonDirectory;
});

const safeProjectName = (input: string): string => {
	const normalized = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized || "project";
};

const storageDirectoryName = (projectName: string, identity: string): string => {
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	return `${safeProjectName(projectName)}-${digest}`;
};

/**
 * Resolve the external instruction location for a working directory.
 *
 * Git worktrees share the location of their common Git directory. A non-Git
 * directory uses its canonical working directory as the project identity.
 *
 * @param cwd - The current Pi working directory.
 * @param storageRoot - The private root outside project repositories.
 * @returns The stable external location for the project.
 */
export const locateProjectInstructions = Effect.fn("ProjectInstructions.locate")(function* (
	cwd: string,
	storageRoot: string,
) {
	const gitMarker = yield* findGitMarker(cwd);
	let identity: ProjectIdentity;

	if (Option.isNone(gitMarker)) {
		const projectRoot = yield* canonicalPath(cwd);
		identity = {
			projectRoot,
			projectName: basename(projectRoot),
			key: `path:${projectRoot}`,
		};
	} else {
		const gitIdentityPath = yield* resolveGitIdentityPath(
			gitMarker.value.projectRoot,
			gitMarker.value.marker,
		);
		identity = {
			projectRoot: gitMarker.value.projectRoot,
			projectName: basename(dirname(gitIdentityPath)),
			key: `git:${gitIdentityPath}`,
		};
	}

	const directory = join(
		resolve(storageRoot),
		storageDirectoryName(identity.projectName, identity.key),
	);
	return {
		projectRoot: identity.projectRoot,
		directory,
		instructionsFile: join(directory, INSTRUCTIONS_FILE_NAME),
	} satisfies ProjectInstructionsLocation;
});

/**
 * Read private instructions when the project's external file exists.
 *
 * @param location - The resolved external project location.
 * @returns The instruction content, or `Option.none()` when no file exists.
 */
export const readProjectInstructions = Effect.fn("ProjectInstructions.read")(function* (
	location: ProjectInstructionsLocation,
) {
	return yield* readOptionalFile(location.instructionsFile, "read");
});

/**
 * Save private instructions with user-only directory and file permissions.
 *
 * @param location - The resolved external project location.
 * @param content - The Markdown instructions to save.
 */
export const writeProjectInstructions = Effect.fn("ProjectInstructions.write")(function* (
	location: ProjectInstructionsLocation,
	content: string,
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs
		.makeDirectory(location.directory, { recursive: true, mode: 0o700 })
		.pipe(Effect.mapError(mapFileSystemError("write", location.directory)));
	yield* fs
		.chmod(location.directory, 0o700)
		.pipe(Effect.mapError(mapFileSystemError("write", location.directory)));

	const temporaryFile = join(location.directory, `.AGENTS-${randomUUID()}.tmp`);
	const atomicWrite = Effect.gen(function* () {
		yield* fs
			.writeFileString(temporaryFile, content, { mode: 0o600 })
			.pipe(Effect.mapError(mapFileSystemError("write", temporaryFile)));
		yield* fs
			.chmod(temporaryFile, 0o600)
			.pipe(Effect.mapError(mapFileSystemError("write", temporaryFile)));
		yield* fs
			.rename(temporaryFile, location.instructionsFile)
			.pipe(Effect.mapError(mapFileSystemError("write", location.instructionsFile)));
	});
	yield* atomicWrite.pipe(
		Effect.ensuring(
			fs.remove(temporaryFile, { force: true }).pipe(Effect.catch(() => Effect.void)),
		),
	);
});

/**
 * Remove a project's private instructions without touching its repository.
 *
 * @param location - The resolved external project location.
 */
export const removeProjectInstructions = Effect.fn("ProjectInstructions.remove")(function* (
	location: ProjectInstructionsLocation,
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs
		.remove(location.instructionsFile, { force: true })
		.pipe(Effect.mapError(mapFileSystemError("remove", location.instructionsFile)));
});
