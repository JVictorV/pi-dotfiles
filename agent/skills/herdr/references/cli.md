# Herdr CLI recipes

Apply the [skill's identity and control boundaries](../SKILL.md).
Use IDs from current responses for the variables below. Commands were checked
against installed CLI help; check the relevant `--help` again if syntax differs.

## Read and wait

Inspect your own pane without relying on UI focus:

```bash
herdr pane get "$HERDR_PANE_ID"
herdr pane list
herdr tab list --workspace "$WORKSPACE_ID"
```

Read a confirmed target:

```bash
herdr pane read "$TARGET_PANE" --source recent-unwrapped --lines 80
```

- `visible` reads the viewport.
- `recent` reads rendered scrollback.
- `recent-unwrapped` joins terminal soft wraps for text inspection.
- `--format ansi` preserves rendered styling when inspecting the TUI.

Use a bounded wait when the next step requires output that is not yet available:

```bash
herdr pane wait-output "$TARGET_PANE" --source recent-unwrapped --match "ready" --timeout 30000
herdr pane wait-output "$TARGET_PANE" --regex 'server.*ready' --timeout 30000
```

The wait searches existing output immediately, then polls. An old matching line
can satisfy it. Choose a marker specific to the run, or confirm the new process's
state separately. A wait without `--timeout` can block indefinitely.

For agents managed outside `herdr_subagent`:

```bash
herdr agent list
herdr agent wait "$TARGET_AGENT" --until done --timeout 60000
```

Get `TARGET_AGENT` from the current agent list. Agent states are `idle`, `working`,
`blocked`, `done`, and `unknown`. Without `--until`, the command accepts `idle`,
`done`, or `blocked`; that alone is not evidence that the task succeeded. Read the
report. For Pi delegation, use the subagent tool's completion delivery instead.

## Create and control

Create without changing the user's focus:

```bash
herdr workspace create --cwd "$PROJECT_DIR" --label "task" --no-focus
herdr tab create --workspace "$WORKSPACE_ID" --cwd "$PROJECT_DIR" --label "logs" --no-focus
herdr pane split "$HERDR_PANE_ID" --direction right --no-focus
```

Choose the one operation needed. Inspect its response, then set `NEW_PANE` to the
returned pane ID. Do not assume that creating a tab or pane changed `HERDR_PANE_ID`.
If creation fails ambiguously, inspect current state before retrying to avoid
creating duplicate terminals.

After confirming that the new pane contains a shell ready for input:

```bash
herdr pane run "$NEW_PANE" "npm run dev"
herdr pane wait-output "$NEW_PANE" --match "ready" --timeout 30000
herdr pane read "$NEW_PANE" --source recent-unwrapped --lines 40
```

For literal terminal input rather than a shell command:

```bash
herdr pane send-text "$TARGET_PANE" "text without Enter"
herdr pane send-keys "$TARGET_PANE" Enter
```

`pane run` sends text and Enter together. Recheck the target process before using
it: the same input could be a shell command, an agent prompt, or application input.

After collecting results, close a task-owned pane with:

```bash
herdr pane close "$NEW_PANE"
```

For tab/workspace focus, rename, or closure, use the matching subcommand's help
and a confirmed target ID. Closing a parent also affects its terminals; check
ownership and unfinished work first.
