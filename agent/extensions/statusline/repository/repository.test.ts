// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
import { describe, expect, test } from "vitest";

import {
	classifyGitHubProfileResult,
	classifyPullRequestFailure,
	classifyPullRequestResult,
	compactGitBranchName,
} from ".";
import { GitHubProfile, PullRequest } from "./state";

const result = (code: number, stdout = "", stderr = "") => ({ stdout, stderr, code });

describe("Git branch display", () => {
	test("uses the task id as compact text for type/description/task-id branches", () => {
		expect(compactGitBranchName("feature/add-status-branch/TASK-9637")).toBe("TASK-9637");
	});

	test("keeps non-matching branch names unchanged", () => {
		expect(compactGitBranchName("feature/add-status-branch")).toBe("feature/add-status-branch");
		expect(compactGitBranchName("feature/add/status/TASK-9637")).toBe(
			"feature/add/status/TASK-9637",
		);
	});
});

describe("GitHub status source", () => {
	test("parses the active gh profile login", () => {
		const profile = classifyGitHubProfileResult(result(0, "octocat\n"));

		expect(GitHubProfile.$is("Active")(profile)).toBe(true);
		if (GitHubProfile.$is("Active")(profile)) expect(profile.login).toBe("octocat");
	});

	test("decodes an open pull request", () => {
		const pullRequest = classifyPullRequestResult(
			result(0, JSON.stringify({ number: 123, url: "https://github.com/acme/repo/pull/123" })),
		);

		expect(PullRequest.$is("Open")(pullRequest)).toBe(true);
		if (PullRequest.$is("Open")(pullRequest)) {
			expect(pullRequest.number).toBe(123);
			expect(pullRequest.url).toBe("https://github.com/acme/repo/pull/123");
		}
	});

	test("classifies no pull request separately from unavailable GitHub", () => {
		expect(
			PullRequest.$is("None")(
				classifyPullRequestFailure(result(1, "", 'no pull requests found for branch "feature"')),
			),
		).toBe(true);
		expect(
			PullRequest.$is("Unavailable")(
				classifyPullRequestFailure(result(1, "", "network unreachable")),
			),
		).toBe(true);
	});
});
