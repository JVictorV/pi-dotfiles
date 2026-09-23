# LSP workflows

Apply the [skill's query and permission rules](../SKILL.md). Choose the operations
that answer the question; these are examples, not mandatory sequences.

## Navigation and edits

### Understand a symbol

Use `hover` for its type and documentation, then `definition` for its owner.
Use `references` when caller behavior or change impact matters. For a large file,
`documentSymbol` can identify the relevant section before a detailed read.

For a workspace symbol search, give a file in the target project so the extension
can select a server:

```json
{
	"operation": "workspaceSymbol",
	"filePath": "src/example.ts",
	"query": "UserService"
}
```

### Trace calls

Use `prepareCallHierarchy` at the symbol, then `incomingCalls` or `outgoingCalls`
at the same position. Read the relevant caller/callee bodies to establish behavior.

### Change a public API

Inspect the definition, references, and representative callers before editing.
Use `rename` for a symbol rename rather than replacing matching text. Review the
resulting diff and verify affected callers. Keep formatting and import changes
within the requested scope.

### Investigate diagnostics

Request `diagnostics` with `filePath`, then use `hover` or `definition` for the
reported types. Check relevant project output if cached diagnostics are incomplete.
After a fix, rerun the checks that demonstrated the problem.

### Apply a code action

List candidates without `actionTitle`:

```json
{
	"operation": "codeAction",
	"filePath": "src/example.ts",
	"codeActionKind": "quickfix"
}
```

Select an action that matches the task, then call again with its exact title.
The extension applies workspace text edits, not arbitrary action commands or
file create/rename/delete operations. See the
[operation reference](../../../extensions/lsp/README.md#model-tool) for examples.

## Troubleshooting

Use `operation: "status"` to check running, missing, or broken servers. The extension
does not install them. Check project dependencies, the Pi config root's
`node_modules/.bin`, and `PATH` before suggesting installation.

If human permission or recovery is needed, identify the specific server and use
these existing commands:

- `/lsp-status` shows server status.
- `/lsp-allow <server>` grants spawn permission for the current repository.
- `/lsp-reset <server|all>` clears stored permission preferences.
- `/lsp-restart <server|all>` clears broken state and stops clients for restart.

Respect a denial. Continue with text search and file reads when sufficient;
report a blocker only when unavailable LSP behavior is required for the task.
An empty response can also mean the server does not implement that operation.
