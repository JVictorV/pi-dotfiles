---
name: herdr-subagents
description: Orchestrate pi subagents as real herdr panels/tabs using the herdr_subagent tool. Use proactively (inside herdr) whenever a task would benefit from delegation or parallelism — multi-part or parallelizable work, broad codebase research, long-running independent tasks, investigate-then-implement pipelines, or pre-ship reviews — and when spawning subagents, inspecting panels, sending follow-ups, or coordinating multi-agent work.
compatibility: Requires running inside herdr (HERDR_ENV=1), the herdr_subagent extension tool, the herdr CLI, and the pi CLI.
---

# herdr-subagents

Use this skill when the current pi session is acting as a lightweight orchestrator for other pi agents in herdr.

This only works inside herdr: the `herdr_subagent` tool refuses every action when `HERDR_ENV` is not `1`. If that happens, tell the user and stop.

## Mental model

- The current agent is the **orchestrator**.
- A **subagent** is a separate pi process running in its own herdr tab/pane.
- One herdr workspace per repo/project; one tab per subagent.
- `spawn` creates the tab and labels it `agent: <name>` automatically — no manual tab management needed.
- Extra split panes (logs, tests, servers) are outside this tool; use the raw herdr CLI or the `herdr` skill for those.

This keeps herdr useful: workspace = project, tab = subagent, pane = terminal.

## Be proactive

Do not wait for the user to say "spawn a subagent". When running inside herdr, treat orchestration as the default way to handle work that is bigger than one focused change. Offer or just do it (matching the user's autonomy preferences) when:

- The task splits into independent parts that can run in parallel (research several areas, fix unrelated failures, migrate many call sites).
- A broad codebase investigation would pollute the orchestrator's context — send a `scout` instead of grepping for 20 turns yourself.
- A long-running task (test suite fixes, large migration, data analysis) can proceed unattended while the conversation continues.
- The task is investigate-then-implement: scout first, then one `worker` with the findings.
- Something is about to ship: spawn a `reviewer` on the diff before declaring it done.
- The user asks for comparisons of alternatives: run them as parallel subagents rather than sequentially in-context.

Stay in-context (no subagents) when the task is a small focused edit, a quick question, or when the overhead of briefing a subagent exceeds doing the work directly. Proactivity means choosing delegation when it genuinely wins, not spawning for everything.

## Model selection

Agent types carry routed model defaults (see `~/.pi/agent/agents/MODEL-MATRIX.md`): sol for planning/debugging/review/taste, terra for implementation/tests, luna for recon/research. Prefer the agent-type default; override `model` only when the matrix favors it for the specific task.

Application rules:

- The openai-codex GPT-5.6 family (sol, terra, luna) is the recommended default; other logged-in models are allowed when the matrix favors them.
- When difficulty is ambiguous, round up a tier; if a terra/luna subagent fails or returns low-quality work, re-spawn the retry on the next tier up instead of retrying the same model.
- Only use `low`, `medium`, `high`, or `xhigh` thinking — never `off` or `minimal`.
- Use `low` for quick scouting, `medium` for research and ordinary analysis, `high` for review and taste judgment, and `xhigh` for implementation, test-writing, planning, and debugging.

## Tool-first workflow

Use the `herdr_subagent` tool. Start with status:

```json
{ "action": "status" }
```

List available agent definitions:

```json
{ "action": "agent-types" }
```

Spawn a panel-backed subagent:

```json
{
	"action": "spawn",
	"name": "investigate-tests",
	"agentType": "scout",
	"thinking": "medium",
	"task": "Run read-only investigation of the failing tests. Diagnose root cause and report files/commands. Do not edit files."
}
```

Inspect its panel:

```json
{ "action": "inspect", "target": "investigate-tests", "lines": 160 }
```

Send a follow-up:

```json
{
	"action": "send",
	"target": "investigate-tests",
	"message": "Please continue, but avoid editing files until I approve the plan."
}
```

`send` works while the subagent is still running — pi queues it as a steering message — and starts a new turn when the subagent is idle.

Do not call `action=wait` after `spawn` or `send`. It blocks the current tool call—by default for up to ten minutes—and prevents the orchestrator from doing useful work while the subagent runs.

Instead, end the current turn and rely on the automatic `subagent_result` follow-up notification (`notify` defaults to `true`). The notification triggers a new orchestrator turn when the subagent finishes or blocks. Inspect the panel before trusting the result:

```json
{ "action": "inspect", "target": "investigate-tests", "lines": 200 }
```

Focus a panel:

```json
{ "action": "focus", "target": "investigate-tests" }
```

Close a panel when its work is harvested:

```json
{ "action": "close", "target": "investigate-tests" }
```

## Task brief template

When spawning a subagent, give it a crisp task brief:

```text
Context:
- Repo/cwd: <path>
- Branch/worktree: <branch or worktree>
- Relevant files: <paths>

Objective:
- <one concrete outcome>

Constraints:
- <read-only / may edit / no commits / run tests / avoid network / etc.>

Deliverable:
- STATUS: done | blocked
- Summary
- Files inspected/changed
- Commands run and results
- Open questions or risks
```

## Orchestration rules

1. Start with a `status` action.
2. Never call `action=wait`; rely on automatic `subagent_result` follow-up notifications and continue only when they arrive.
3. Spawn at most 12 subagents; start small and scale toward that only when the task genuinely benefits from fan-out.
4. For research/review/testing tasks, subagents may share the same worktree.
5. For parallel code-writing tasks, avoid multiple subagents editing the same worktree. Use separate worktrees/workspaces or serialize the edit phase.
6. Prefer read-only diagnostic/scout tasks first, then choose one implementation agent.
7. Always inspect a subagent's panel before trusting its result.
8. Summarize subagent outputs back to the user with names, statuses, and important file paths.
9. Close subagents after summarizing their results, unless the user wants the panel kept open.

## Failure handling

Failed actions reject with an error message; read it before retrying.

- `spawn` fails with "already registered": `close` that name first (close also cleans up stale entries whose tab is already gone) or pick a new name.
- Other herdr failures (exit codes, timeouts): run `status` to re-sync pane ids, then retry once. Do not blindly re-`spawn` — check whether the panel was actually created first.

## Agent definitions

The tool can use user-level agent definitions from `~/.pi/agent/agents/*.md` and, only when requested, project-local definitions from `.pi/agents/*.md`.

Preferred default roles:

- `scout` — read-only codebase reconnaissance; defaults to Sol with `low` thinking.
- `researcher` — cited web research; defaults to Sol with `medium` thinking.
- `planner` — read-only implementation planning; defaults to Sol with `high` thinking.
- `reviewer` — read-only code review with P0-P3 findings; defaults to Sol with `high` thinking.
- `worker` — general implementation worker; defaults to Sol with `high` thinking.
- `test-writer` — writes tests through real seams; defaults to Sol with `high` thinking.
- `debugger` — root-cause diagnosis with temporary instrumentation; defaults to Sol with `high` thinking.
- `critic` — high-taste critique of UI/copy/API/design alternatives; defaults to Sol with `high` thinking.

Role definitions set default `model` and `thinking`; spawn params override both. Use `agentType` on spawn to select a role. Omit `agentType` for a plain pi subagent, but still pass an explicit `model`.

## Lower-level fallback

If the `herdr_subagent` tool is unavailable, use raw herdr commands:

```bash
herdr agent list
herdr pane list
herdr tab create --workspace <workspace-id> --label "agent: tests" --no-focus
herdr pane read <pane-id> --source recent-unwrapped --lines 120
herdr pane run <pane-id> "<message or command>"
herdr agent list
```

For detailed pane/tab/workspace control, load the `herdr` skill too.
