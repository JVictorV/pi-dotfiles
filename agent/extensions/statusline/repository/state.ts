import { Data } from "effect";

import { makeStatusLineStateKey } from "../core/state";

/** Branch state supplied by the repository feature. */
export type GitBranch = Data.TaggedEnum<{
	Unknown: {};
	NotRepository: {};
	Unavailable: {};
	Active: { readonly name: string };
}>;

/** Constructors and matchers for {@link GitBranch}. */
export const GitBranch = Data.taggedEnum<GitBranch>();

/** Active GitHub CLI profile state. */
export type GitHubProfile = Data.TaggedEnum<{
	Unknown: {};
	Unavailable: {};
	Active: { readonly login: string };
}>;

/** Constructors and matchers for {@link GitHubProfile}. */
export const GitHubProfile = Data.taggedEnum<GitHubProfile>();

/** Pull request state for the current Git branch. */
export type PullRequest = Data.TaggedEnum<{
	Unknown: {};
	None: {};
	Unavailable: {};
	Open: { readonly number: number; readonly url: string };
}>;

/** Constructors and matchers for {@link PullRequest}. */
export const PullRequest = Data.taggedEnum<PullRequest>();

/** Repository feature state read by repository segments. */
export type RepositoryStatus = {
	readonly branch: GitBranch;
	readonly profile: GitHubProfile;
	readonly pullRequest: PullRequest;
};

/** Initial repository feature state before Git/GitHub sources report. */
export const INITIAL_REPOSITORY_STATUS: RepositoryStatus = {
	branch: GitBranch.Unknown(),
	profile: GitHubProfile.Unknown(),
	pullRequest: PullRequest.Unknown(),
};

/** State key for the repository feature. */
export const REPOSITORY_STATUS = makeStatusLineStateKey<RepositoryStatus>({
	id: "repository",
	initial: INITIAL_REPOSITORY_STATUS,
	equals: repositoryStatusEquals,
});

/** Compare repository feature states. */
export function repositoryStatusEquals(left: RepositoryStatus, right: RepositoryStatus): boolean {
	return (
		gitBranchEquals(left.branch, right.branch) &&
		gitHubProfileEquals(left.profile, right.profile) &&
		pullRequestEquals(left.pullRequest, right.pullRequest)
	);
}

/** Compare Git branch states. */
export const gitBranchEquals = (left: GitBranch, right: GitBranch): boolean =>
	GitBranch.$match(left, {
		Unknown: () => GitBranch.$is("Unknown")(right),
		NotRepository: () => GitBranch.$is("NotRepository")(right),
		Unavailable: () => GitBranch.$is("Unavailable")(right),
		Active: (active) => GitBranch.$is("Active")(right) && active.name === right.name,
	});

/** Compare GitHub profile states. */
export const gitHubProfileEquals = (left: GitHubProfile, right: GitHubProfile): boolean =>
	GitHubProfile.$match(left, {
		Unknown: () => GitHubProfile.$is("Unknown")(right),
		Unavailable: () => GitHubProfile.$is("Unavailable")(right),
		Active: (active) => GitHubProfile.$is("Active")(right) && active.login === right.login,
	});

/** Compare pull request states. */
export const pullRequestEquals = (left: PullRequest, right: PullRequest): boolean =>
	PullRequest.$match(left, {
		Unknown: () => PullRequest.$is("Unknown")(right),
		None: () => PullRequest.$is("None")(right),
		Unavailable: () => PullRequest.$is("Unavailable")(right),
		Open: (open) =>
			PullRequest.$is("Open")(right) && open.number === right.number && open.url === right.url,
	});
