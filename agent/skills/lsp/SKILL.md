---
name: lsp
description: Use the LSP tool for symbol navigation, types, diagnostics, and language-aware edits.
---

# LSP code intelligence

Prefer `lsp` for semantic relationships: definitions, references, types, symbols,
call hierarchy, and diagnostics. Use text search for literal strings or when the
server is unavailable or incomplete. The tool schema lists operations and inputs.

## Query rules

- Positions use 1-based lines and 1-based UTF-16 character offsets. Use `read` or a
  focused text search to locate a symbol when its position is unknown.
- Include `filePath` for workspace symbols and diagnostics when a matching server
  must start. Without it, these operations only use already-running clients.
- Diagnostics are cached. An empty result is not proof that the project typechecks;
  use relevant project checks when diagnostics do not resolve the question.

## Edits and permissions

Inspect the relevant code before an edit. Check references for public or cross-file
renames, and explain broad edits before applying them. List code actions before
applying an exact `actionTitle`; actions without workspace edits are not applied.
Use formatting only when requested or needed for a touched file.

Respect the extension's server-start and mutation permissions. It normally asks
for interactive approval; do not change permission settings to bypass a denial.
Review generated edits and run affected diagnostics or project checks.

## References

- **Navigation or edit sequences:** Read [workflows](references/workflows.md#navigation-and-edits)
  when a single query does not answer the task.
- **Missing, denied, stale, or incomplete servers:** Read
  [troubleshooting](references/workflows.md#troubleshooting).
- **Operation examples, configuration, or implementation limits:** Read the matching
  section of the [extension README](../../extensions/lsp/README.md).
