---
name: code-review
description: Claude-style code review for diffs, PRs, branches, or uncommitted changes. Use when the user asks to review code, run /review, /code-review, inspect a PR for merge blockers, or find bugs/regressions/security issues in a change.
---

# Code Review

Review code like a strict maintainer. Your job is to find actionable defects in the proposed change, not to summarize or fix it.

This skill is a behavioral reconstruction of Claude-style `/review` / `/code-review`: inspect the diff, understand enough surrounding code to evaluate it, verify claims where practical, and report merge-blocking findings first.

## Operating mode

- **Reviewer, not implementer.** Do not edit files unless the user explicitly asks for fixes after the review.
- **Find defects, not preferences.** Prioritize correctness, security, data loss, regressions, missing migrations, broken API contracts, concurrency/idempotency issues, and test gaps that could let those defects ship.
- **Review the change under review.** Do not criticize unrelated legacy code unless the diff makes it newly reachable or worse.
- **No rubber-stamping.** If you find nothing, say so plainly and include what you checked and any residual risk.
- **No vague findings.** Every finding needs a concrete failure mode and a precise code location.

## Determine the review target

Use the user's explicit target if provided: PR number/URL, branch, commit range, file list, or staged/uncommitted changes.

If no target is provided, infer one in this order:

1. Staged and unstaged worktree changes:
   - `git diff --stat`
   - `git diff --cached --stat`
   - `git diff`
   - `git diff --cached`
2. Current PR, if available:
   - `gh pr view --json number,baseRefName,headRefName,url` when `gh` is configured
3. Current branch against its merge base with the default base branch:
   - find base from PR metadata, `origin/main`, `main`, `origin/master`, or `master`
   - `git merge-base HEAD <base>`
   - `git diff <merge-base>...HEAD`

If the repo is using stacked PRs or the user mentions a stack, run the `stack` skill/tool first for stack-aware context. Prefer reviewing the specific stack slice the user named, not the whole stack accidentally.

## Review workflow

### 1. Build a mental model of the diff

Run lightweight discovery before reading deeply:

- `git status --short`
- `git diff --stat` for worktree reviews, or the equivalent range stat for branch/PR reviews
- file list and high-level themes: source, tests, migrations, generated files, config, docs

Then inspect the actual patch. For each meaningful changed area, read enough surrounding code to understand invariants:

- the full changed function/class/module, not only patch hunks
- definitions of newly used symbols
- call sites of changed public APIs
- tests for the touched behavior
- schema/migration/config files that constrain the code
- relevant docs/ADRs/`CONTEXT.md` if present

Use LSP for definitions/references when semantic navigation is better than grep.

### 2. Review for merge-blocking risks

Look for these classes of issues first:

1. **Correctness/regression:** wrong condition, missing branch, off-by-one, bad async sequencing, stale state, race, accidental behavior change.
2. **Security/auth/privacy:** missing authorization, trust boundary confusion, injection, path traversal, unsafe deserialization, secret/token leakage in logs/errors/tests.
3. **Data integrity:** migration incompatibility, lossy transform, non-idempotent retry, transaction boundary bug, duplicate writes, partial failure with no recovery.
4. **API/contract breakage:** changed exported behavior, DTO/schema mismatch, backwards-incompatible response, broken CLI/env/config assumptions.
5. **Error handling/observability:** swallowed expected failures, unhandled promises, misleading errors, loss of safe diagnostic context.
6. **Tests:** missing or weakened tests for risky new behavior; tests that assert implementation details while the bug-prone behavior remains untested.
7. **Performance/resource use:** obvious N+1, unbounded memory, leaked handles, pathological loops introduced by the change.

Ignore pure style, naming, formatting, small refactors, or alternate designs unless they create a concrete bug or the user asked for design review.

### 3. Verify before reporting when practical

For each suspected issue, try to falsify it:

- Trace the exact input/state that reaches the bug.
- Check whether callers already guard the invariant.
- Check tests or fixtures that may already cover the case.
- Run targeted commands when cheap and safe: unit tests for touched files, typecheck, lint, build, or a focused repro.

Do not run broad or destructive commands without user approval. If you cannot verify, mark the confidence honestly and explain what would confirm it.

### 4. Compose findings

Findings must be actionable and compact. Prefer one finding per root cause.

Each finding format:

```markdown
- **P1 — Short imperative/problem title** (`path/to/file.ts:123`)
  The changed code does <specific thing>. When <specific scenario/input>, <bad outcome> happens because <mechanism>. This would <user/system impact>. Consider <minimal direction for a fix>.
```

Severity rubric:

- **P0:** immediate security incident, data loss, service outage, or change must not ship.
- **P1:** likely production bug, serious regression, auth bypass, corrupt data, or broken core path.
- **P2:** real bug in an edge case, missing guard, meaningful test gap for risky behavior.
- **P3:** minor issue worth fixing but not normally merge-blocking. Use sparingly; omit nits by default.

Location rules:

- Point to the smallest changed line that introduces or exposes the issue.
- If the failure manifests elsewhere, explain that in the text but anchor the finding on the diff.
- Use file paths and line numbers when available.

## Output format

Start with findings. Do not lead with praise or a broad summary.

If there are findings:

```markdown
## Findings

- **P1 — ...** (`file:line`)
  ...

## Checks

- Reviewed diff: <range/PR/worktree>
- Ran: `<command>` — <result>
- Not run: <commands/reasons, if relevant>
```

If there are no findings:

```markdown
No findings.

## Checks

- Reviewed diff: <range/PR/worktree>
- Inspected: <key files/areas>
- Ran: `<command>` — <result>
- Residual risk: <anything not covered, or "none obvious">
```

## Anti-patterns

Do not:

- rewrite the patch during review mode
- list every changed file as a summary
- give generic advice without a failing scenario
- report pre-existing issues unrelated to the diff
- request broad rewrites when a narrow fix addresses the bug
- complain about missing tests unless you can name the risky behavior that needs coverage
- treat formatting, personal taste, or architecture preference as a finding without concrete impact
