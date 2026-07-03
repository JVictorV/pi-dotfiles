---
name: herdr-subagents
description: Orchestrate pi subagents as real herdr panels/tabs using the herdr_subagent tool. Use when spawning subagents, inspecting their panels, sending follow-ups, waiting for completion, or coordinating multi-agent work in herdr.
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

## Model selection

Fable is usually the **orchestrator**, not the worker. When spawning subagents, pass an explicit `model` unless the user specifically asks to inherit the current/default model.

Rankings are practical defaults for this setup, not hard limits. Higher is better. Cost reflects local effective cost/limits, not list price. Intelligence means how hard a problem the model can handle unsupervised; taste covers UI/UX, code quality, API design, and copy.

| model                       | cost | intelligence | taste | use                                                                                                                                             |
| --------------------------- | ---: | -----------: | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.5`      |    9 |            8 |     5 | Default worker for clear-spec implementation, data analysis, migrations, tests, broad codebase search, and mechanical/bulk work.                |
| `anthropic/claude-opus-4-8` |    4 |            7 |     8 | Reviews, architecture/design judgment, UI/API/copy taste, ambiguous bugs, plan critique, and synthesis.                                         |
| `anthropic/claude-fable-5`  |    2 |            9 |     9 | Usually keep as orchestrator. Spawn only for pure high-taste critique, copy/UI direction, or when explicitly comparing subjective alternatives. |

Application rules:

- These are defaults, not limits. If output is mediocre, rerun/escalate with a better-fit model without asking.
- Cost is a tie-breaker only. For anything that ships, intelligence > taste > cost.
- Use `openai-codex/gpt-5.5` for most implementation workers and read-only scouts.
- Use `anthropic/claude-opus-4-8` for reviewers, planners, ambiguous investigations, product/API/UI/copy judgment, and final synthesis.
- Avoid spawning `anthropic/claude-fable-5` as a worker by default; Fable's job here is orchestration.
- Never use Haiku or other low-end models for this workflow.
- For high-risk tasks, set `thinking` to `high` or `xhigh`. For mechanical scouts, `medium` is usually enough.

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
	"model": "openai-codex/gpt-5.5",
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

Wait for completion:

```json
{ "action": "wait", "target": "investigate-tests", "status": "done", "timeoutMs": 600000 }
```

Then inspect before trusting the result:

```json
{ "action": "inspect", "target": "investigate-tests", "lines": 200 }
```

Herdr's raw `done` status means "finished but not yet viewed"; a viewed pane reports `idle` instead. The tool's `done` wait handles this: it polls and completes on either `done` or a stable `idle`, so it works even when a human is watching the subagent's tab. A `done` wait timing out therefore means the subagent is genuinely still working (or blocked) — inspect the panel.

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
2. Spawn at most 12 subagents; start small and scale toward that only when the task genuinely benefits from fan-out.
3. For research/review/testing tasks, subagents may share the same worktree.
4. For parallel code-writing tasks, avoid multiple subagents editing the same worktree. Use separate worktrees/workspaces or serialize the edit phase.
5. Prefer read-only diagnostic/scout tasks first, then choose one implementation agent.
6. Always inspect a subagent's panel before trusting its result.
7. Summarize subagent outputs back to the user with names, statuses, and important file paths.
8. Close subagents after summarizing their results, unless the user wants the panel kept open.

## Failure handling

Failed actions reject with an error message; read it before retrying.

- `wait` timeout: not fatal. The timeout message includes the last observed agent status. Inspect the panel — the subagent may still be working or blocked — then re-wait or ask the user.
- `spawn` fails with "already registered": `close` that name first (close also cleans up stale entries whose tab is already gone) or pick a new name.
- Other herdr failures (exit codes, timeouts): run `status` to re-sync pane ids, then retry once. Do not blindly re-`spawn` — check whether the panel was actually created first.

## Agent definitions

The tool can use user-level agent definitions from `~/.pi/agent/agents/*.md` and, only when requested, project-local definitions from `.pi/agents/*.md`.

Preferred default roles:

- `scout` — read-only codebase reconnaissance; defaults to `openai-codex/gpt-5.5`.
- `planner` — read-only implementation planning; defaults to `anthropic/claude-opus-4-8`.
- `reviewer` — read-only code review with P0-P3 findings; defaults to `anthropic/claude-opus-4-8`.
- `worker` — general implementation worker; defaults to `openai-codex/gpt-5.5`.
- `debugger` — root-cause diagnosis with temporary instrumentation; defaults to `anthropic/claude-opus-4-8`.
- `critic` — high-taste critique of UI/copy/API/design alternatives; defaults to `anthropic/claude-fable-5`. This is the one legitimate reason to spawn Fable.

Role definitions set default `model` and `thinking`; spawn params override both. Use `agentType` on spawn to select a role. Omit `agentType` for a plain pi subagent, but still pass an explicit `model`.

## Lower-level fallback

If the `herdr_subagent` tool is unavailable, use raw herdr commands:

```bash
herdr agent list
herdr pane list
herdr tab create --workspace <workspace-id> --label "agent: tests" --no-focus
herdr pane read <pane-id> --source recent-unwrapped --lines 120
herdr pane run <pane-id> "<message or command>"
herdr wait agent-status <pane-id> --status done --timeout 600000
```

For detailed pane/tab/workspace control, load the `herdr` skill too.
