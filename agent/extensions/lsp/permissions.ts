import { dirname } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Option, Predicate, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { LspPermissionFileError, lspErrorReason } from "./errors";
import { permissionPath } from "./paths";
import type { LspPermission, LspPermissionFile } from "./types";

const failPermissionFile = (reason: string): Effect.Effect<never, LspPermissionFileError> =>
	Effect.fail(LspPermissionFileError.make({ reason }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const NotFoundError = Schema.Struct({ code: Schema.Literal("ENOENT") });
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeNotFoundError = Schema.decodeUnknownOption(NotFoundError);

const isNotFoundPlatformError = (error: PlatformError): boolean =>
	Predicate.isTagged(error.reason, "NotFound");

const platformCause = (error: PlatformError): unknown => error.reason.cause ?? error;

const isNotFoundError = (error: unknown): boolean => Option.isSome(decodeNotFoundError(error));

const isPermission = (value: unknown): value is LspPermission =>
	value === "allow" || value === "deny";

const emptyPermissionFile = (): LspPermissionFile => ({ version: 1, repos: {} });

const parsePermissionFile = Effect.fn("parsePermissionFile")(function* (value: unknown) {
	if (!isRecord(value)) {
		return yield* failPermissionFile("agent/lsp-permissions.json must contain a JSON object");
	}
	if (value.version !== 1) {
		return yield* failPermissionFile("agent/lsp-permissions.json has an unsupported version");
	}
	if (!isRecord(value.repos)) {
		return yield* failPermissionFile("agent/lsp-permissions.json field repos must be an object");
	}

	const repos: Record<string, Record<string, LspPermission>> = {};
	for (const [repoRoot, repoPermissions] of Object.entries(value.repos)) {
		if (!isRecord(repoPermissions)) {
			return yield* failPermissionFile(
				`agent/lsp-permissions.json repo ${repoRoot} must be an object`,
			);
		}

		const permissions: Record<string, LspPermission> = {};
		for (const [serverId, permission] of Object.entries(repoPermissions)) {
			if (!isPermission(permission)) {
				return yield* failPermissionFile(
					`agent/lsp-permissions.json permission ${repoRoot}.${serverId} must be allow or deny`,
				);
			}
			permissions[serverId] = permission;
		}
		repos[repoRoot] = permissions;
	}

	return { version: 1, repos } satisfies LspPermissionFile;
});

const permissionWriteLock = Semaphore.makeUnsafe(1);
let tempFileCounter = 0;

const parseJson = (text: string): Effect.Effect<unknown, LspPermissionFileError> =>
	decodeUnknownJson(text).pipe(
		Effect.mapError(() =>
			LspPermissionFileError.make({
				reason: "agent/lsp-permissions.json must contain valid JSON",
			}),
		),
	);

const missingPermissionFileReason = "agent/lsp-permissions.json not found";

const readPermissionFile = Effect.fn("readPermissionFile")(function* () {
	const path = permissionPath();
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(path, "utf8").pipe(
		Effect.mapError((error) =>
			LspPermissionFileError.make({
				reason:
					isNotFoundPlatformError(error) || isNotFoundError(platformCause(error))
						? missingPermissionFileReason
						: lspErrorReason(platformCause(error), "failed to read agent/lsp-permissions.json"),
			}),
		),
		Effect.catchTag("LspPermissionFileError", (error) =>
			error.reason === missingPermissionFileReason ? Effect.succeed(undefined) : Effect.fail(error),
		),
	);

	if (text === undefined) return emptyPermissionFile();

	const json = yield* parseJson(text);
	return yield* parsePermissionFile(json);
});

const writePermissionFile = Effect.fn("writePermissionFile")(function* (file: LspPermissionFile) {
	const path = permissionPath();
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
		Effect.mapError((error) =>
			LspPermissionFileError.make({
				reason: lspErrorReason(platformCause(error), "failed to create agent directory"),
			}),
		),
	);
	const tmpPath = `${path}.${process.pid}.${tempFileCounter++}.tmp`;
	yield* fs.writeFileString(tmpPath, `${JSON.stringify(file, null, "\t")}\n`).pipe(
		Effect.mapError((error) =>
			LspPermissionFileError.make({
				reason: lspErrorReason(platformCause(error), "failed to write agent/lsp-permissions.json"),
			}),
		),
	);
	yield* fs.rename(tmpPath, path).pipe(
		Effect.mapError((error) =>
			LspPermissionFileError.make({
				reason: lspErrorReason(
					platformCause(error),
					"failed to replace agent/lsp-permissions.json",
				),
			}),
		),
	);
});

export class LspPermissionStore {
	private file: LspPermissionFile;

	private constructor(file: LspPermissionFile) {
		this.file = file;
	}

	static load(): Effect.Effect<LspPermissionStore, LspPermissionFileError> {
		return readPermissionFile().pipe(
			Effect.map((file) => new LspPermissionStore(file)),
			Effect.provide(NodeFileSystem.layer),
		);
	}

	get(repoRoot: string, serverId: string): LspPermission | undefined {
		return this.file.repos[repoRoot]?.[serverId];
	}

	entries(repoRoot: string): ReadonlyArray<readonly [string, LspPermission]> {
		return Object.entries(this.file.repos[repoRoot] ?? {}).sort(([left], [right]) =>
			left.localeCompare(right),
		);
	}

	set(
		repoRoot: string,
		serverId: string,
		permission: LspPermission,
	): Effect.Effect<void, LspPermissionFileError> {
		const updateFile = (file: LspPermissionFile): void => {
			this.file = file;
		};
		return permissionWriteLock
			.withPermit(
				Effect.gen(function* () {
					const file = yield* readPermissionFile();
					file.repos[repoRoot] = {
						...file.repos[repoRoot],
						[serverId]: permission,
					};
					yield* writePermissionFile(file);
					updateFile(file);
				}),
			)
			.pipe(Effect.provide(NodeFileSystem.layer));
	}

	reset(repoRoot: string, serverId?: string): Effect.Effect<void, LspPermissionFileError> {
		const updateFile = (file: LspPermissionFile): void => {
			this.file = file;
		};
		return permissionWriteLock
			.withPermit(
				Effect.gen(function* () {
					const file = yield* readPermissionFile();

					if (serverId === undefined) {
						delete file.repos[repoRoot];
						yield* writePermissionFile(file);
						updateFile(file);
						return;
					}

					const repo = file.repos[repoRoot];
					if (repo !== undefined) {
						delete repo[serverId];
						if (Object.keys(repo).length === 0) {
							delete file.repos[repoRoot];
						}
					}

					yield* writePermissionFile(file);
					updateFile(file);
				}),
			)
			.pipe(Effect.provide(NodeFileSystem.layer));
	}
}
