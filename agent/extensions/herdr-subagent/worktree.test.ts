import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
	cleanupHarness,
	installFakeHerdr,
	loadTool,
	makeContext,
	makeTempRoot,
	readHerdrCalls,
	runHerdrSubagentEffect,
	setEnv,
	writeAgent,
} from "./test-harness";
import { decodeJsonString, decodeRegistryEntry } from "./schemas";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "./worktree";
import type { RegistryEntry } from "./types";

const repos: string[] = [];

afterEach(async () => {
	await cleanupHarness();
	for (const repo of repos.splice(0)) {
		try {
			execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" });
		} catch {
			// Best-effort test cleanup.
		}
		rmSync(repo, { recursive: true, force: true });
	}
});

const initGitRepo = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hsa-wt-"));
	repos.push(dir);
	execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# Test repo\n");
	execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
	return dir;
};

const git = (cwd: string, args: ReadonlyArray<string>): string =>
	execFileSync("git", [...args], { cwd, stdio: "pipe" })
		.toString()
		.trim();

const tabCreateCalls = (
	calls: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> =>
	calls.filter((args) => args[0] === "tab" && args[1] === "create");

const argAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};

const readRegistryEntry = async (agentDir: string, name: string): Promise<RegistryEntry> => {
	const text = await readFile(
		join(agentDir, "herdr-subagents", "registry", `${name}.json`),
		"utf8",
	);
	const parsed = await runHerdrSubagentEffect(decodeJsonString(text));
	return await runHerdrSubagentEffect(decodeRegistryEntry(parsed));
};

describe("git worktree isolation", () => {
	test("createWorktree preserves monorepo subdirectory scoping", async () => {
		const repo = initGitRepo();
		const packageDir = join(repo, "packages", "api");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "index.ts"), "export {};\n");
		execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "add package"], { cwd: repo, stdio: "pipe" });

		const worktree = await runHerdrSubagentEffect(createWorktree(packageDir, "worker-a"));

		expect(worktree.branch).toBe("pi-agent-worker-a");
		expect(worktree.baseSha).toBe(git(repo, ["rev-parse", "HEAD"]));
		expect(worktree.workPath).toBe(join(worktree.path, "packages", "api"));
		expect(existsSync(join(worktree.workPath, "index.ts"))).toBe(true);
		await runHerdrSubagentEffect(cleanupWorktree(packageDir, worktree, "clean package"));
		expect(existsSync(worktree.path)).toBe(false);
	});

	test("createWorktree prunes stale worktree metadata before creating a new worktree", async () => {
		const repo = initGitRepo();
		const orphaned = await runHerdrSubagentEffect(createWorktree(repo, "orphaned-a"));
		rmSync(orphaned.path, { recursive: true, force: true });
		expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(orphaned.path);

		const next = await runHerdrSubagentEffect(createWorktree(repo, "orphaned-b"));

		expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(orphaned.path);
		await runHerdrSubagentEffect(cleanupWorktree(repo, next, "clean next"));
	});

	test("cleanupWorktree preserves an agent's own commit on a branch", async () => {
		const repo = initGitRepo();
		const worktree = await runHerdrSubagentEffect(createWorktree(repo, "committed-a"));
		writeFileSync(join(worktree.path, "committed.txt"), "agent committed this\n");
		execFileSync("git", ["add", "committed.txt"], { cwd: worktree.path, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "agent commit"], { cwd: worktree.path, stdio: "pipe" });
		const agentHead = git(worktree.path, ["rev-parse", "HEAD"]);

		const cleanup = await runHerdrSubagentEffect(
			cleanupWorktree(repo, worktree, "already committed"),
		);

		expect(cleanup).toEqual({
			hasChanges: true,
			branch: "pi-agent-committed-a",
			path: worktree.path,
		});
		expect(git(repo, ["rev-parse", "pi-agent-committed-a"])).toBe(agentHead);
		expect(existsSync(worktree.path)).toBe(false);
	});

	test("cleanupWorktree commits dirty leftovers with --no-verify", async () => {
		const repo = initGitRepo();
		writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		const worktree = await runHerdrSubagentEffect(createWorktree(repo, "hooked-a"));
		writeFileSync(join(worktree.path, "leftover.txt"), "agent wrote this\n");

		const cleanup = await runHerdrSubagentEffect(cleanupWorktree(repo, worktree, "leftovers"));

		expect(cleanup.branch).toBe("pi-agent-hooked-a");
		expect(git(repo, ["show", "pi-agent-hooked-a:leftover.txt"])).toBe("agent wrote this");
		expect(existsSync(worktree.path)).toBe(false);
	});

	test("cleanupWorktree preserves the worktree on git cleanup failure", async () => {
		const repo = initGitRepo();
		const worktree = await runHerdrSubagentEffect(createWorktree(repo, "preserve-a"));
		try {
			execFileSync("git", ["config", "commit.gpgsign", "true"], {
				cwd: worktree.path,
				stdio: "pipe",
			});
			execFileSync("git", ["config", "gpg.program", "false"], {
				cwd: worktree.path,
				stdio: "pipe",
			});
			writeFileSync(join(worktree.path, "leftover.txt"), "agent wrote this\n");

			const cleanup = await runHerdrSubagentEffect(
				cleanupWorktree(repo, worktree, "cleanup should fail"),
			);

			expect(cleanup).toMatchObject({
				hasChanges: false,
				path: worktree.path,
				preserved: true,
			});
			expect(cleanup.reason).toContain("git commit --no-verify");
			expect(existsSync(worktree.path)).toBe(true);
			expect(git(worktree.path, ["status", "--porcelain"])).toContain("leftover.txt");
		} finally {
			rmSync(worktree.path, { recursive: true, force: true });
			await runHerdrSubagentEffect(pruneWorktrees(repo));
		}
	});

	test("spawn isolation uses the worktree workPath and close preserves changes", async () => {
		const root = await makeTempRoot();
		const agentDir = join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const repo = initGitRepo();
		const packageDir = join(repo, "packages", "api");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "index.ts"), "export {};\n");
		execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "add package"], { cwd: repo, stdio: "pipe" });
		const tool = await loadTool(agentDir);

		const spawned = await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-a",
				agentType: "worker",
				task: "Implement in the package.",
				cwd: packageDir,
				isolation: "worktree",
			},
			undefined,
			undefined,
			makeContext(repo),
		);
		const entry = await readRegistryEntry(agentDir, "worker-a");
		const worktree = entry.worktree;
		expect(worktree).toBeDefined();
		if (!worktree) {
			throw new Error("expected worktree metadata");
		}
		expect(spawned.content[0]?.text).toContain(`CWD: ${worktree.workPath}`);
		expect(worktree.workPath).toBe(join(worktree.path, "packages", "api"));
		const creates = tabCreateCalls(await readHerdrCalls(log));
		expect(creates).toHaveLength(1);
		expect(argAfter(creates[0] ?? [], "--cwd")).toBe(worktree.workPath);

		await writeFile(join(worktree.workPath, "agent.txt"), "preserved by close\n", "utf8");
		const closed = await tool.execute(
			"tool-call-close",
			{ action: "close", target: "worker-a" },
			undefined,
			undefined,
			makeContext(repo),
		);

		expect(closed.content[0]?.text).toContain(
			"Worktree changes were preserved on branch pi-agent-worker-a",
		);
		expect(git(repo, ["show", "pi-agent-worker-a:packages/api/agent.txt"])).toBe(
			"preserved by close",
		);
		expect(existsSync(worktree.path)).toBe(false);
		await expect(
			access(join(agentDir, "herdr-subagents", "registry", "worker-a.json")),
		).rejects.toThrow();
	});

	test("close reports a preserved worktree that needs manual cleanup", async () => {
		const root = await makeTempRoot();
		const agentDir = join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const repo = initGitRepo();
		const tool = await loadTool(agentDir);

		await tool.execute(
			"tool-call",
			{
				action: "spawn",
				name: "worker-preserved",
				agentType: "worker",
				task: "Leave changes behind.",
				cwd: repo,
				isolation: "worktree",
			},
			undefined,
			undefined,
			makeContext(repo),
		);
		const entry = await readRegistryEntry(agentDir, "worker-preserved");
		const worktree = entry.worktree;
		expect(worktree).toBeDefined();
		if (!worktree) {
			throw new Error("expected worktree metadata");
		}
		try {
			execFileSync("git", ["config", "commit.gpgsign", "true"], {
				cwd: worktree.path,
				stdio: "pipe",
			});
			execFileSync("git", ["config", "gpg.program", "false"], {
				cwd: worktree.path,
				stdio: "pipe",
			});
			await writeFile(join(worktree.path, "leftover.txt"), "manual cleanup needed\n", "utf8");

			const closed = await tool.execute(
				"tool-call-close",
				{ action: "close", target: "worker-preserved" },
				undefined,
				undefined,
				makeContext(repo),
			);

			expect(closed.content[0]?.text).toContain(
				`Worktree cleanup could not safely complete; preserved ${worktree.path} for manual attention.`,
			);
			expect(existsSync(worktree.path)).toBe(true);
		} finally {
			rmSync(worktree.path, { recursive: true, force: true });
			await runHerdrSubagentEffect(pruneWorktrees(repo));
		}
	});

	test("spawn isolation rejects non-git cwd instead of spawning unisolated", async () => {
		const root = await makeTempRoot();
		const agentDir = join(root, "agent");
		await writeAgent(agentDir, "worker", "openai-codex/gpt-5.6-sol");
		const { log } = await installFakeHerdr(root);
		setEnv("HERDR_ENV", "1");
		const nonGit = join(root, "not-git");
		await rm(nonGit, { recursive: true, force: true });
		mkdirSync(nonGit, { recursive: true });
		const tool = await loadTool(agentDir);

		await expect(
			tool.execute(
				"tool-call",
				{
					action: "spawn",
					name: "worker-a",
					agentType: "worker",
					task: "Do not spawn unisolated.",
					cwd: nonGit,
					isolation: "worktree",
				},
				undefined,
				undefined,
				makeContext(root),
			),
		).rejects.toThrow(/inside a git repository/);
		expect(tabCreateCalls(await readHerdrCalls(log))).toHaveLength(0);
		await expect(
			access(join(agentDir, "herdr-subagents", "registry", "worker-a.json")),
		).rejects.toThrow();
	});
});
