import { hyperlink } from "@earendil-works/pi-tui";
import { Effect, Option, Schedule, Schema } from "effect";

import type { StatusLineFeature } from "../core/feature";
import type { StatusLineSegment } from "../core/segment";
import { getStatusLineState, StatusLineStateStore } from "../core/state";
import { StatusLineShell, type StatusLineExecResult } from "../core/shell";
import { GitBranch, GitHubProfile, PullRequest, REPOSITORY_STATUS } from "./state";

const GIT_REFRESH_INTERVAL = "5 seconds";
const GITHUB_REFRESH_INTERVAL = "60 seconds";
const PrInfo = Schema.Struct({ number: Schema.Number, url: Schema.String });
const PrInfoJson = Schema.fromJsonString(PrInfo);
const decodePrInfoJsonOption = Schema.decodeUnknownOption(PrInfoJson);
const TASK_BRANCH_PATTERN = /^[^/]+\/[^/]+\/([^/]+)$/u;

/** Segment that renders the current Git branch and active GitHub profile. */
export const repositorySegment: StatusLineSegment = {
	id: "git",
	order: 30,
	dropPriority: 20,
	render: ({ snapshot, context }) => {
		const repository = getStatusLineState(snapshot, REPOSITORY_STATUS);
		const branch = repository.branch;
		if (!GitBranch.$is("Active")(branch)) return Option.none();

		const branchText =
			context.theme.fg("dim", "(") +
			context.theme.fg("mdLink", branch.name) +
			context.theme.fg("dim", ")");
		const profile = repository.profile;
		const profileText = GitHubProfile.$is("Active")(profile)
			? context.theme.fg("dim", "[") +
				context.theme.fg("accent", profile.login) +
				context.theme.fg("dim", "]")
			: "";

		return Option.some({
			full: branchText + profileText,
			compact: context.theme.fg("mdLink", compactGitBranchName(branch.name)),
		});
	},
};

/** Segment that renders the open pull request for the current branch. */
export const pullRequestSegment: StatusLineSegment = {
	id: "pull-request",
	order: 40,
	dropPriority: 30,
	render: ({ snapshot, context }) => {
		const repository = getStatusLineState(snapshot, REPOSITORY_STATUS);
		const pullRequest = repository.pullRequest;
		if (!PullRequest.$is("Open")(pullRequest)) return Option.none();

		const label = context.theme.fg("mdLink", `⇡#${pullRequest.number}`);
		return Option.some({
			full: context.terminal.hyperlinks ? hyperlink(label, pullRequest.url) : label,
		});
	},
};

const refreshGitStatus = Effect.gen(function* () {
	const shell = yield* StatusLineShell;
	const store = yield* StatusLineStateStore;
	const branch = yield* shell.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], 3000).pipe(
		Effect.map(classifyGitBranchResult),
		Effect.catch(() => Effect.succeed(GitBranch.Unavailable())),
	);
	return yield* store.update(REPOSITORY_STATUS, (previous) => ({ ...previous, branch }));
});

const refreshGitHubProfile = Effect.gen(function* () {
	const shell = yield* StatusLineShell;
	const store = yield* StatusLineStateStore;
	const profile = yield* shell
		.exec(
			"gh",
			[
				"auth",
				"status",
				"--active",
				"--json",
				"hosts",
				"--jq",
				'.hosts | add | map(select(.active and .state == "success")) | .[0].login // ""',
			],
			5000,
		)
		.pipe(
			Effect.map(classifyGitHubProfileResult),
			Effect.catch(() => Effect.succeed(GitHubProfile.Unavailable())),
		);
	return yield* store.update(REPOSITORY_STATUS, (previous) => ({ ...previous, profile }));
});

const refreshPullRequest = Effect.gen(function* () {
	const shell = yield* StatusLineShell;
	const store = yield* StatusLineStateStore;
	const snapshot = yield* store.get;
	const repository = getStatusLineState(snapshot, REPOSITORY_STATUS);
	const branch = repository.branch;
	if (!GitBranch.$is("Active")(branch)) {
		yield* store.update(REPOSITORY_STATUS, (previous) => ({
			...previous,
			pullRequest: PullRequest.Unknown(),
		}));
		return;
	}

	const pullRequest = yield* shell
		.exec("gh", ["pr", "view", branch.name, "--json", "number,url"], 5000)
		.pipe(
			Effect.map(classifyPullRequestResult),
			Effect.catch(() => Effect.succeed(PullRequest.Unavailable())),
		);
	yield* store.update(REPOSITORY_STATUS, (previous) => ({ ...previous, pullRequest }));
});

const refreshGitAndBranchPullRequest = Effect.gen(function* () {
	const gitChanged = yield* refreshGitStatus;
	if (gitChanged) yield* refreshPullRequest;
});

const refreshGitHubStatus = Effect.all([refreshGitHubProfile, refreshPullRequest], {
	concurrency: "unbounded",
}).pipe(Effect.asVoid);

/** Compact a Git branch for narrow status-line layouts. */
export function compactGitBranchName(branchName: string): string {
	const match = TASK_BRANCH_PATTERN.exec(branchName);
	const taskId = match?.[1];
	return taskId ?? branchName;
}

/** Repository feature: Git branch, GitHub profile, and branch pull request status. */
export const repositoryFeature: StatusLineFeature = {
	id: "repository",
	segments: [repositorySegment, pullRequestSegment],
	start: Effect.all(
		[
			refreshGitAndBranchPullRequest.pipe(
				Effect.repeat(Schedule.spaced(GIT_REFRESH_INTERVAL)),
				Effect.asVoid,
			),
			refreshGitHubStatus.pipe(
				Effect.repeat(Schedule.spaced(GITHUB_REFRESH_INTERVAL)),
				Effect.asVoid,
			),
		],
		{ concurrency: "unbounded", discard: true },
	),
	onTurnEnd: refreshGitAndBranchPullRequest,
};

/** Classify `git rev-parse --abbrev-ref HEAD` output into a branch state. */
export function classifyGitBranchResult(result: StatusLineExecResult): GitBranch {
	if (result.code === 0) {
		const branch = result.stdout.trim().replace(/^HEAD$/, "");
		return branch ? GitBranch.Active({ name: branch }) : GitBranch.Unavailable();
	}

	const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
	if (output.includes("not a git repository") || output.includes("not a git repo")) {
		return GitBranch.NotRepository();
	}

	return GitBranch.Unavailable();
}

/** Classify `gh auth status --active` output into profile state. */
export function classifyGitHubProfileResult(result: StatusLineExecResult): GitHubProfile {
	if (result.code !== 0) return GitHubProfile.Unavailable();
	const login = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
	return login ? GitHubProfile.Active({ login }) : GitHubProfile.Unavailable();
}

/** Classify `gh pr view` output into pull request state. */
export function classifyPullRequestResult(result: StatusLineExecResult): PullRequest {
	if (result.code !== 0) return classifyPullRequestFailure(result);
	const decoded = decodePrInfoJsonOption(result.stdout);
	return Option.isSome(decoded)
		? PullRequest.Open({ number: decoded.value.number, url: decoded.value.url })
		: PullRequest.Unavailable();
}

/** Classify a non-zero `gh pr view` result. */
export function classifyPullRequestFailure(result: StatusLineExecResult): PullRequest {
	const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
	if (
		(output.includes("no pull request") || output.includes("no pull requests")) &&
		(output.includes("found") || output.includes("open"))
	) {
		return PullRequest.None();
	}
	if (output.includes("could not find") && output.includes("pull request")) {
		return PullRequest.None();
	}
	return PullRequest.Unavailable();
}
