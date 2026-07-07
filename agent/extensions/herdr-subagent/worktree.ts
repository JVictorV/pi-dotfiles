import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Clock, Effect, Result, Schema } from "effect";

/** Metadata for a temporary git worktree used to isolate a spawned subagent. */
export interface WorktreeInfo {
	/** Absolute path to the temporary worktree repository root. */
	readonly path: string;
	/** Branch name used to preserve the subagent's completed work. */
	readonly branch: string;
	/** Commit SHA that the worktree was detached from. */
	readonly baseSha: string;
	/** Cwd-equivalent path inside the worktree, preserving monorepo subdirectory scope. */
	readonly workPath: string;
}

/** Cleanup outcome for a temporary git worktree. */
export interface WorktreeCleanupResult {
	/** Whether uncommitted changes or new commits were preserved on a branch. */
	readonly hasChanges: boolean;
	/** Branch name containing preserved changes, when changes were found. */
	readonly branch?: string;
	/** Worktree path that was cleaned up or deliberately preserved for manual recovery. */
	readonly path?: string;
	/** True when cleanup failed and the worktree was left on disk to avoid losing work. */
	readonly preserved?: true;
	/** Human-readable reason the preserved worktree needs manual attention. */
	readonly reason?: string;
}

/** A git subprocess failed while managing an isolated worktree. */
export class GitCommandFailed extends Schema.TaggedErrorClass<GitCommandFailed>()(
	"GitCommandFailed",
	{
		message: Schema.String,
		cwd: Schema.String,
		args: Schema.Array(Schema.String),
		cause: Schema.Defect(),
	},
) {}

/** A git worktree isolation operation failed before a subagent could be safely spawned. */
export class WorktreeIsolationFailed extends Schema.TaggedErrorClass<WorktreeIsolationFailed>()(
	"WorktreeIsolationFailed",
	{
		message: Schema.String,
		cwd: Schema.String,
		operation: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const git = (cwd: string, args: ReadonlyArray<string>, timeout: number): string =>
	execFileSync("git", [...args], { cwd, stdio: "pipe", timeout })
		.toString()
		.trim();

const gitFailure = (cwd: string, args: ReadonlyArray<string>, cause: unknown): GitCommandFailed =>
	new GitCommandFailed({
		cwd,
		args: [...args],
		message: `Git command failed in ${cwd}: git ${args.join(" ")}`,
		cause,
	});

const gitEffect = (
	cwd: string,
	args: ReadonlyArray<string>,
	timeout: number,
): Effect.Effect<string, GitCommandFailed> =>
	Effect.try({
		try: () => git(cwd, args, timeout),
		catch: (cause) => gitFailure(cwd, args, cause),
	});

const isolationFailure = (
	cwd: string,
	operation: string,
	message: string,
	cause: unknown,
): WorktreeIsolationFailed => new WorktreeIsolationFailed({ cwd, operation, message, cause });

const cleanupFailureReason = (failure: GitCommandFailed): string => failure.message;

/**
 * Prune stale git worktree metadata for crash recovery.
 *
 * @param cwd - Cwd inside the source repository whose worktree metadata should be pruned.
 * @returns Nothing; pruning failures are ignored because this is best-effort recovery.
 */
export const pruneWorktrees: (cwd: string) => Effect.Effect<void> = Effect.fnUntraced(
	function* (cwd) {
		yield* gitEffect(cwd, ["worktree", "prune"], 5_000).pipe(
			Effect.catch(() => Effect.succeed("")),
		);
	},
);

/**
 * Create a temporary detached git worktree for an isolated subagent spawn.
 *
 * The returned `workPath` matches the caller's original cwd inside the copied worktree, so spawning
 * from a monorepo package does not silently widen the agent's working directory to the repository
 * root. Both the git toplevel and input cwd are realpathed before relative path calculation so
 * symlinked temp paths (for example `/tmp` on macOS) preserve the correct subdirectory.
 *
 * If the extension host dies before close-time cleanup, the temporary `pi-agent-*` directory can be
 * left behind. `createWorktree` runs `git worktree prune` before creating a new worktree in the same
 * repo so Git can reclaim stale metadata for manually deleted orphaned worktrees.
 *
 * @param cwd - Cwd requested for the subagent spawn.
 * @param agentId - Parsed subagent name used in the temporary path and preservation branch.
 * @returns Worktree metadata, or `WorktreeIsolationFailed` when isolation cannot be guaranteed.
 */
export const createWorktree: (
	cwd: string,
	agentId: string,
) => Effect.Effect<WorktreeInfo, WorktreeIsolationFailed> = Effect.fnUntraced(
	function* (cwd, agentId) {
		const inside = yield* Effect.result(
			gitEffect(cwd, ["rev-parse", "--is-inside-work-tree"], 5_000),
		);
		if (Result.isFailure(inside)) {
			return yield* Effect.fail(
				isolationFailure(
					cwd,
					"rev-parse --is-inside-work-tree",
					`Worktree isolation requires cwd to be inside a git repository: ${cwd}`,
					inside.failure,
				),
			);
		}

		yield* pruneWorktrees(cwd);

		const baseSha = yield* gitEffect(cwd, ["rev-parse", "HEAD"], 5_000).pipe(
			Effect.mapError((cause) =>
				isolationFailure(
					cwd,
					"rev-parse HEAD",
					`Worktree isolation requires the git repository to have at least one commit: ${cwd}`,
					cause,
				),
			),
		);

		const subdir = yield* Effect.try({
			try: () => {
				const topLevel = git(cwd, ["rev-parse", "--show-toplevel"], 5_000);
				return relative(realpathSync(topLevel), realpathSync(cwd));
			},
			catch: (cause) =>
				isolationFailure(
					cwd,
					"rev-parse --show-toplevel",
					`Worktree isolation could not resolve the git repository root for cwd: ${cwd}`,
					cause,
				),
		});

		const branch = `pi-agent-${agentId}`;
		const suffix = randomUUID().slice(0, 8);
		const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
		yield* gitEffect(cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30_000).pipe(
			Effect.mapError((cause) =>
				isolationFailure(
					cwd,
					"worktree add",
					`Worktree isolation could not create a temporary git worktree for cwd: ${cwd}`,
					cause,
				),
			),
		);
		return {
			path: worktreePath,
			branch,
			baseSha,
			workPath: subdir ? join(worktreePath, subdir) : worktreePath,
		};
	},
);

/**
 * Clean up an isolated subagent worktree after the pane is closed.
 *
 * Clean worktrees at their original `baseSha` are removed silently. Dirty worktrees are staged and
 * committed with `--no-verify`, then a branch is created at the worktree HEAD so both the agent's
 * own commits and any leftover uncommitted changes are preserved for the orchestrator to merge.
 * If cleanup fails, the worktree is deliberately left on disk and reported as preserved instead of
 * force-removed, because force-removing after a git failure can destroy uncommitted work.
 *
 * @param cwd - Original spawn cwd in the source repository.
 * @param worktree - Worktree metadata recorded at spawn time.
 * @param agentDescription - Text used to build the local preservation commit message.
 * @returns Whether changes were preserved, including the branch name when present.
 */
export const cleanupWorktree: (
	cwd: string,
	worktree: WorktreeInfo,
	agentDescription: string,
) => Effect.Effect<WorktreeCleanupResult> = Effect.fnUntraced(
	function* (cwd, worktree, agentDescription) {
		const exists = yield* Effect.sync(() => existsSync(worktree.path));
		if (!exists) {
			return { hasChanges: false };
		}
		const cleanup = yield* Effect.result(cleanupExistingWorktree(cwd, worktree, agentDescription));
		if (Result.isSuccess(cleanup)) {
			return cleanup.success;
		}
		return {
			hasChanges: false,
			path: worktree.path,
			preserved: true,
			reason: cleanupFailureReason(cleanup.failure),
		};
	},
);

/**
 * Best-effort force removal for a temporary worktree that was created before spawn failed.
 *
 * @param cwd - Original spawn cwd in the source repository.
 * @param worktreePath - Temporary worktree root path to unregister and remove.
 * @returns Nothing.
 */
export const removeWorktree: (cwd: string, worktreePath: string) => Effect.Effect<void> =
	Effect.fnUntraced(function* (cwd, worktreePath) {
		const removed = yield* Effect.result(
			gitEffect(cwd, ["worktree", "remove", "--force", worktreePath], 10_000),
		);
		if (Result.isFailure(removed)) {
			yield* pruneWorktrees(cwd);
		}
	});

const cleanupExistingWorktree: (
	cwd: string,
	worktree: WorktreeInfo,
	agentDescription: string,
) => Effect.Effect<WorktreeCleanupResult, GitCommandFailed> = Effect.fnUntraced(
	function* (cwd, worktree, agentDescription) {
		const status = yield* gitEffect(worktree.path, ["status", "--porcelain"], 10_000);
		if (status) {
			yield* gitEffect(worktree.path, ["add", "-A"], 10_000);
			const safeDescription = agentDescription.slice(0, 200);
			yield* gitEffect(
				worktree.path,
				["commit", "--no-verify", "-m", `pi-agent: ${safeDescription}`],
				10_000,
			);
		} else {
			const currentSha = yield* gitEffect(worktree.path, ["rev-parse", "HEAD"], 5_000);
			if (currentSha === worktree.baseSha) {
				yield* removeWorktree(cwd, worktree.path);
				return { hasChanges: false };
			}
		}

		const branch = yield* createBranch(worktree.path, worktree.branch);
		yield* removeWorktree(cwd, worktree.path);
		return { hasChanges: true, branch, path: worktree.path };
	},
);

const createBranch: (cwd: string, branch: string) => Effect.Effect<string, GitCommandFailed> =
	Effect.fnUntraced(function* (cwd, branch) {
		const created = yield* Effect.result(gitEffect(cwd, ["branch", branch], 5_000));
		if (Result.isSuccess(created)) {
			return branch;
		}
		const now = yield* Clock.currentTimeMillis;
		const suffixed = `${branch}-${now}`;
		yield* gitEffect(cwd, ["branch", suffixed], 5_000);
		return suffixed;
	});
