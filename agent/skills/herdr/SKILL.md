---
name: herdr
description: Control Herdr workspaces, tabs, panes, and terminal input through the CLI. Use for raw terminal management, not Pi subagent delegation.
---

# Herdr terminal control

For Pi subagents, use `herdr_subagent` and the
[herdr-subagents skill](../herdr-subagents/SKILL.md). Use this skill for other
terminal work, or when the subagent tool is unavailable.

## Environment and identity

- Require `HERDR_ENV=1` before inspecting or controlling panels. Otherwise, stop
  panel operations and continue independently authorized work directly.
- Identify your own pane with `HERDR_PANE_ID`. Check it with
  `herdr pane get "$HERDR_PANE_ID"`. If the variable is missing or the lookup fails,
  report that panel-control blocker. Never substitute the focused pane.
- Use the workspace and tab IDs returned for that pane when targeting its parents.
  Treat IDs as opaque. Get other target IDs from current list/get/create responses;
  do not construct them or assume an old ID still identifies the same target.
- Preserve the configured session/socket environment. Focus is a UI choice, not
  evidence of pane ownership or permission to send commands.

## Choose the operation

Use installed help as the source of truth for command syntax:
`herdr pane --help`, `herdr tab --help`, `herdr workspace --help`, or help for a
specific subcommand.

- **Read or wait for output:** Read [CLI recipes](references/cli.md#read-and-wait)
  for snapshot sources, bounded waits, and agent states.
- **Create terminals or send input:** Read [CLI recipes](references/cli.md#create-and-control)
  for explicit targets and creation responses.
- **Protocol integration:** Consult the [socket API documentation](https://herdr.dev/docs/socket-api/)
  only when CLI help does not answer the protocol question.

## Control boundaries

Inspect the target before sending input. `pane run` types into its current process;
use it as a shell command only when the target is a shell ready for input.
Prefer `--no-focus` when creating terminals. Change focus only when interaction
requires it. Close only terminals created for this task or explicitly authorized
by the user, after collecting their results. Keep secrets out of commands and output.
