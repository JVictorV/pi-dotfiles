import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result } from "effect";
import { join } from "node:path";

import { appendPrivateProjectInstructions, appendPrivateProjectInstructionsFailure } from "./index";
import {
	locateProjectInstructions,
	readProjectInstructions,
	removeProjectInstructions,
	writeProjectInstructions,
} from "./storage";

const modeBits = (mode: number): number => mode & 0o777;

const provideFileSystem = <A, E>(
	program: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E> => program.pipe(Effect.provide(NodeFileSystem.layer));

describe("private project instructions", () => {
	it.effect("maps a repository and its subdirectories to one external AGENTS.md", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const projectRoot = join(tempRoot, "project");
				const nestedDirectory = join(projectRoot, "src", "feature");
				const storageRoot = join(tempRoot, "private-data");
				yield* fs.makeDirectory(join(projectRoot, ".git"), { recursive: true });
				yield* fs.makeDirectory(nestedDirectory, { recursive: true });

				const fromRoot = yield* locateProjectInstructions(projectRoot, storageRoot);
				const fromNested = yield* locateProjectInstructions(nestedDirectory, storageRoot);

				assert.strictEqual(fromNested.instructionsFile, fromRoot.instructionsFile);
				assert.isTrue(fromRoot.instructionsFile.startsWith(storageRoot));
				assert.isFalse(fromRoot.instructionsFile.startsWith(projectRoot));
				assert.isTrue(fromRoot.instructionsFile.endsWith("AGENTS.md"));
			}).pipe(Effect.scoped),
		),
	);

	it.effect("shares private instructions across Git worktrees", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const mainProject = join(tempRoot, "main-project");
				const commonGitDirectory = join(mainProject, ".git");
				const worktreeMetadata = join(commonGitDirectory, "worktrees", "topic");
				const worktreeProject = join(tempRoot, "topic-worktree");
				const storageRoot = join(tempRoot, "private-data");

				yield* fs.makeDirectory(worktreeMetadata, { recursive: true });
				yield* fs.makeDirectory(worktreeProject, { recursive: true });
				yield* fs.writeFileString(join(worktreeMetadata, "commondir"), "../..\n");
				yield* fs.writeFileString(
					join(worktreeMetadata, "gitdir"),
					`${join(worktreeProject, ".git")}\n`,
				);
				yield* fs.writeFileString(join(worktreeProject, ".git"), `gitdir: ${worktreeMetadata}\n`);

				const mainLocation = yield* locateProjectInstructions(mainProject, storageRoot);
				const worktreeLocation = yield* locateProjectInstructions(worktreeProject, storageRoot);

				assert.strictEqual(worktreeLocation.instructionsFile, mainLocation.instructionsFile);
			}).pipe(Effect.scoped),
		),
	);

	it.effect("does not let a forged gitdir file reuse another project's instructions", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const victimProject = join(tempRoot, "victim");
				const attackerProject = join(tempRoot, "attacker");
				const victimGitDirectory = join(victimProject, ".git");
				const storageRoot = join(tempRoot, "private-data");

				yield* fs.makeDirectory(victimGitDirectory, { recursive: true });
				yield* fs.makeDirectory(attackerProject, { recursive: true });
				yield* fs.writeFileString(join(attackerProject, ".git"), `gitdir: ${victimGitDirectory}\n`);

				const victimLocation = yield* locateProjectInstructions(victimProject, storageRoot);
				const attackerLocation = yield* locateProjectInstructions(attackerProject, storageRoot);

				assert.notStrictEqual(attackerLocation.instructionsFile, victimLocation.instructionsFile);
			}).pipe(Effect.scoped),
		),
	);

	it.effect("rejects forged worktree metadata outside the claimed common directory", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const victimGitDirectory = join(tempRoot, "victim", ".git");
				const attackerProject = join(tempRoot, "attacker");
				const attackerMarker = join(attackerProject, ".git");
				const forgedMetadata = join(tempRoot, "forged-worktree-metadata");
				const storageRoot = join(tempRoot, "private-data");

				yield* fs.makeDirectory(victimGitDirectory, { recursive: true });
				yield* fs.makeDirectory(attackerProject, { recursive: true });
				yield* fs.makeDirectory(forgedMetadata, { recursive: true });
				yield* fs.writeFileString(attackerMarker, `gitdir: ${forgedMetadata}\n`);
				yield* fs.writeFileString(join(forgedMetadata, "gitdir"), `${attackerMarker}\n`);
				yield* fs.writeFileString(join(forgedMetadata, "commondir"), `${victimGitDirectory}\n`);

				const outcome = yield* Effect.result(
					locateProjectInstructions(attackerProject, storageRoot),
				);
				assert.isTrue(Result.isFailure(outcome));
			}).pipe(Effect.scoped),
		),
	);

	it.effect("rejects a symbolic .git marker that could spoof another project", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const victimGitDirectory = join(tempRoot, "victim", ".git");
				const attackerProject = join(tempRoot, "attacker");
				const storageRoot = join(tempRoot, "private-data");

				yield* fs.makeDirectory(victimGitDirectory, { recursive: true });
				yield* fs.makeDirectory(attackerProject, { recursive: true });
				yield* fs.symlink(victimGitDirectory, join(attackerProject, ".git"));

				const outcome = yield* Effect.result(
					locateProjectInstructions(attackerProject, storageRoot),
				);
				assert.isTrue(Result.isFailure(outcome));
			}).pipe(Effect.scoped),
		),
	);

	it.effect("writes, reads, and removes instructions with private permissions", () =>
		provideFileSystem(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pi-project-agents-" });
				const projectRoot = join(tempRoot, "project");
				const storageRoot = join(tempRoot, "private-data");
				yield* fs.makeDirectory(projectRoot, { recursive: true });
				const location = yield* locateProjectInstructions(projectRoot, storageRoot);

				yield* writeProjectInstructions(location, "Use local rules.\n");
				const loaded = yield* readProjectInstructions(location);

				assert.strictEqual(Option.getOrUndefined(loaded), "Use local rules.\n");
				assert.strictEqual(
					yield* fs.readFileString(location.instructionsFile),
					"Use local rules.\n",
				);
				assert.strictEqual(modeBits((yield* fs.stat(location.directory)).mode), 0o700);
				assert.strictEqual(modeBits((yield* fs.stat(location.instructionsFile)).mode), 0o600);

				yield* removeProjectInstructions(location);
				const removed = yield* readProjectInstructions(location);
				assert.isTrue(Option.isNone(removed));
			}).pipe(Effect.scoped),
		),
	);

	it("appends only non-empty private instructions", () => {
		assert.strictEqual(appendPrivateProjectInstructions("base prompt", "  \n"), "base prompt");
		assert.strictEqual(
			appendPrivateProjectInstructions("base prompt", "Keep secrets out of logs.\n"),
			"base prompt\n\n# Private Project Instructions\n\nKeep secrets out of logs.\n",
		);
	});

	it("stops the turn when private instructions cannot be loaded safely", () => {
		const prompt = appendPrivateProjectInstructionsFailure("base prompt");
		assert.isTrue(prompt.includes("Private Project Instructions Unavailable"));
		assert.isTrue(prompt.includes("Do not continue the requested task"));
	});
});
