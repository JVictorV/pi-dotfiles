---
name: lsp
description: Language Server Protocol semantic code intelligence for pi. Use when navigating code by definitions, references, implementations, hover/type info, symbols, call hierarchy, diagnostics, or when applying safe LSP edits such as rename, formatting, code actions, or organize imports.
---

# LSP Code Intelligence

Use pi's `lsp` tool when semantic information is better than text search. It is best for questions like "where is this symbol defined?", "who calls this?", "what type is this?", "what references must change?", and "what diagnostics does the language server see?"

For full extension details, read [the LSP extension README](../../extensions/lsp/README.md).

## Default Behavior

Prefer `lsp` over `rg`/grep for semantic relationships:

- definitions and implementations
- references and call sites
- hover/type information
- file and workspace symbols
- call hierarchy
- language-server diagnostics
- language-aware rename/format/code-action edits

Use `rg`/grep for plain text searches, config strings, TODOs, generated text, or when the language server is unavailable/incomplete.

## Position Rules

Position-based operations need editor-style positions:

- `line` is 1-based.
- `character` is 1-based and uses UTF-16 offsets.
- The character can usually point anywhere inside the target symbol.

If you do not know the exact position, first inspect the file with `read` or use a focused `rg -n` search to find the line, then count to a character inside the symbol.

## Read-Only Operations

### Jump to a definition

```json
{
  "operation": "definition",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

Use for imported functions/classes, component references, methods, types, variables, and unfamiliar APIs.

### Find references

```json
{
  "operation": "references",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

Use before changing public APIs, renaming symbols, deleting code, or judging impact.

### Inspect hover/type info

```json
{
  "operation": "hover",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

Use when TypeScript inference, overloads, doc comments, or framework-generated types matter.

### List symbols in a file

```json
{
  "operation": "documentSymbol",
  "filePath": "src/example.ts"
}
```

Use to map a large file before reading it deeply.

### Search workspace symbols

```json
{
  "operation": "workspaceSymbol",
  "filePath": "src/example.ts",
  "query": "UserService"
}
```

Include `filePath` so the extension can start the right server. Without it, only already-running servers are queried.

### Explore call hierarchy

First prepare the call hierarchy at the symbol:

```json
{
  "operation": "prepareCallHierarchy",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

Then ask for callers or callees:

```json
{
  "operation": "incomingCalls",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

```json
{
  "operation": "outgoingCalls",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8
}
```

Use this for behavior tracing, dependency direction, and safe refactors.

### Check diagnostics

```json
{
  "operation": "diagnostics",
  "filePath": "src/example.ts"
}
```

Use after edits or while diagnosing type/lint errors. Diagnostics are cached by running servers; if results seem incomplete, start with a target `filePath`, then fall back to project test/typecheck commands when necessary.

### Check server status

```json
{
  "operation": "status"
}
```

Use when a query fails, returns nothing unexpectedly, or you need to know which servers are available/running/broken.

## Mutating Operations

Mutating LSP operations require interactive approval before files are written. Use them only when they directly match the user's request or when the next safe step is obvious.

Before mutating:

1. Inspect the target with read-only `lsp` operations.
2. Prefer `references` before renaming public or cross-file symbols.
3. Explain broad changes briefly if the edit will touch many files.
4. After mutation, run targeted diagnostics or the project's normal checks.

### Rename a symbol

```json
{
  "operation": "rename",
  "filePath": "src/example.ts",
  "line": 12,
  "character": 8,
  "newName": "renamedSymbol"
}
```

Use for language-aware renames instead of search-and-replace.

### Format a file

```json
{
  "operation": "formatting",
  "filePath": "src/example.ts"
}
```

Use only when formatting is requested or needed for a touched file. The extension currently requests document formatting with `tabSize: 2` and `insertSpaces: false`; project formatters may still be authoritative.

### List or apply code actions

List available actions first:

```json
{
  "operation": "codeAction",
  "filePath": "src/example.ts",
  "codeActionKind": "quickfix"
}
```

Apply an exact title only after seeing it:

```json
{
  "operation": "codeAction",
  "filePath": "src/example.ts",
  "codeActionKind": "quickfix",
  "actionTitle": "Fix all auto-fixable problems"
}
```

Code actions without workspace edits are not applied.

### Organize imports

```json
{
  "operation": "organizeImports",
  "filePath": "src/example.ts"
}
```

Use after import-heavy edits when the language server supports it.

## Common Workflows

### Understand an unfamiliar symbol

1. `hover` on the symbol.
2. `definition` to inspect its owner module.
3. `references` to see usage patterns.
4. `incomingCalls`/`outgoingCalls` if behavior flows through functions.

### Safely change a public API

1. `definition` on the API.
2. `references` on the API.
3. Read the owner module and representative call sites.
4. Make the code change.
5. Use `diagnostics` on touched files and run targeted tests/typecheck.

### Investigate a type error

1. `diagnostics` on the failing file.
2. `hover` on the mismatched expression and expected type.
3. `definition` on relevant types/helpers.
4. Apply the smallest code fix.
5. Re-run `diagnostics` or project checks.

### Large-file orientation

1. `documentSymbol` for the file structure.
2. Read only the relevant symbol bodies.
3. Use `references`/call hierarchy to expand outward as needed.

## Troubleshooting

- The extension does not install language servers. If a server is missing, check project dependencies, the pi config root dependencies (`~/.pi/node_modules/.bin`), or PATH before suggesting installation.
- The first query for a repo may prompt the human to allow starting a server.
- If a server is denied, broken, or stale, ask the human to use `/lsp-status`, `/lsp-allow <server>`, `/lsp-reset <server|all>`, or `/lsp-restart <server|all>` as appropriate.
- If LSP output is empty but the code clearly exists, fall back to `rg` and direct file reads; not every language server supports every operation.
- Do not use LSP mutating operations as a substitute for careful review of generated edits.
