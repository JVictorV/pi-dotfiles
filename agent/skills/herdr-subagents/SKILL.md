---
name: herdr-subagents
description: Delegate Pi tasks and manage their panels with herdr_subagent.
compatibility: Requires Herdr wire protocol 21, HERDR_ENV=1, HERDR_PANE_ID, the herdr_subagent extension with its SDK dependency installed, and the pi CLI.
---

# Herdr subagents

The tool owns panel creation, registry identity, worktree isolation, and completion
delivery. Its schema documents operation parameters.

## When to delegate

Delegate independent research, implementation, tests, or review when it reduces
elapsed time or keeps a broad investigation out of the parent context. Do small,
focused tasks directly when a task brief would cost more than the work.

Require `HERDR_ENV=1` for panel operations. Otherwise, continue independently
authorized work directly; report a blocker only if the outcome requires panels.
The extension uses `HERDR_PANE_ID`, not the focused pane, for its own identity.

## Scope and model selection

- Use `isolation: "worktree"` for implementation. Read-only agents may share the
  checkout. Recheck isolation and edit permission before changing a read-only task
  into an editing task. Closing an isolated agent preserves changes on its reported
  `pi-agent-<name>` branch; it does not merge them into the parent checkout.
- Keep at most 12 concurrent agents. Grant `allowSpawn` only when recursive
  delegation is needed, within that same budget.
- Role frontmatter owns defaults. Use `action: "agent-types"` to discover them.
  Read [MODEL-MATRIX.md](../../agents/MODEL-MATRIX.md) before overriding model or effort.
- Load project-level agent definitions only when requested and trusted. Keep the
  tool's confirmation unless the user explicitly authorizes skipping it.

## Task and lifecycle

1. Call `action: "status"` before controlling existing panels. Use a new registered
   name for each active agent; close the old registration before reusing a name.
2. Spawn with the repository/cwd, one objective, relevant files, edit permissions,
   commit/network limits, verification, and expected report. Ask for `STATUS: done`
   or `STATUS: blocked`, changed files, actual check results, and remaining risks.
3. Continue independent parent work. Spawn/send normally deliver a final
   `subagent_result` before the parent's next model response. Use that report directly.
4. Inspect only for progress, missing details, or separate verification. Inspection
   consumes matching complete report copies; partial samples do not consume unread
   details. A closed panel is not evidence that its report was read.
5. Send follow-up work if needed. Send queues input when the agent is active. After
   collecting the work, close the panel unless the user wants it kept open. Close
   directly, without an acknowledgment-only message that creates another report.

Use `wait` only when the next step needs the result and no independent work remains.
Do not poll with waits. Use `focus` only when interaction is needed; inspection does
not require a focus change.

## Recovery

After a transport or lookup failure, check `status` and retry once if safe. Confirm
whether a spawn succeeded before retrying it; an uncertain response can leave a real
panel behind. Confirmed closed-panel reports need no new lookup, respawn, or
acknowledgment. Treat a genuinely unknown target as an error.

If the tool is unavailable, use the [Herdr CLI skill](../herdr/SKILL.md) for raw panel
control. Its identity rules and installed CLI help apply; do not assume tool-managed
registry or completion behavior exists for manually launched agents.
