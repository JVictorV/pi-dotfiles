# LSP Extension

Language Server Protocol support for pi. The extension gives the model semantic code-navigation tools that are more precise than grepping for text: definitions, references, hover/type info, symbols, call hierarchy, and diagnostics. It can also apply selected LSP edits after interactive approval: rename, formatting, code actions, and organize imports.

The implementation is adapted from opencode's LSP architecture, but runs as a global pi extension and does not import from `.repos/opencode` at runtime.

## What it provides

### Model tool

Registers one tool: `lsp`.

Supported read/query operations:

- `definition`
- `references`
- `hover`
- `documentSymbol`
- `workspaceSymbol`
- `implementation`
- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`
- `diagnostics`
- `status`

Supported mutating operations, all requiring interactive approval before writing files:

- `rename`
- `formatting`
- `codeAction`
- `organizeImports`

For position-based operations, pass:

```json
{
	"operation": "definition",
	"filePath": "src/example.ts",
	"line": 12,
	"character": 8
}
```

`line` and `character` are **1-based editor positions**. LSP character offsets are UTF-16 offsets.

For workspace symbols:

```json
{
	"operation": "workspaceSymbol",
	"filePath": "src/example.ts",
	"query": "MySymbol"
}
```

`filePath` lets the extension choose and start a matching LSP server. Without `filePath`, `workspaceSymbol` only queries already-running clients.

For diagnostics:

```json
{
	"operation": "diagnostics",
	"filePath": "src/example.ts"
}
```

With `filePath`, diagnostics may start matching diagnostic-capable servers and then return cached diagnostics for that file. Without `filePath`, diagnostics returns cached diagnostics from already-running clients.

For rename:

```json
{
	"operation": "rename",
	"filePath": "src/example.ts",
	"line": 12,
	"character": 8,
	"newName": "renamedSymbol"
}
```

For formatting:

```json
{
	"operation": "formatting",
	"filePath": "src/example.ts"
}
```

Formatting currently requests document formatting with `tabSize: 2` and `insertSpaces: false`.

For code actions, omit `actionTitle` to list available actions; pass an exact title to apply that action's workspace edit:

```json
{
	"operation": "codeAction",
	"filePath": "src/example.ts",
	"codeActionKind": "quickfix",
	"actionTitle": "Fix all auto-fixable problems"
}
```

Code actions that do not return a workspace edit are not applied.

For organize imports:

```json
{
	"operation": "organizeImports",
	"filePath": "src/example.ts"
}
```

Mutating operations fail in non-interactive contexts because they require a UI confirmation prompt before any files are written. Workspace edits are limited to text edits for `file://` documents; resource operations such as file create/rename/delete are not supported.

### Status line

The extension emits `lsp:status` events consumed by `statusline.ts`. The bar shows compact LSP state as:

```txt
LSP (Not running)
LSP (TS)
LSP (TS, Rust, Python)
```

Broken clients are appended as `!(Name)`, for example `LSP (TS) !(Python)`.

### Slash commands

Human-facing commands:

- `/lsp-status` — show available servers and running clients
- `/lsp-permissions` — show stored allow/deny preferences for the current repo
- `/lsp-allow <server>` — allow spawning a server for the current repo
- `/lsp-deny <server>` — deny spawning a server for the current repo
- `/lsp-reset <server|all>` — clear stored preferences for the current repo
- `/lsp-restart <server|all>` — stop running clients and clear session-broken state

## Permission model

The extension prompts before starting an LSP server for a repository. Your answer is stored globally by canonical repository path in:

```txt
~/.pi/agent/lsp-permissions.json
```

This file contains local absolute paths and is gitignored.

The repo identity is:

1. the canonical Git root when available
2. otherwise the canonical pi session `cwd`

Both `allow` and `deny` are persisted so pi does not keep asking.

## Built-in servers

The v1 registry includes:

| Server ID                    | File types                                                   | Binary                                  |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `typescript`                 | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | `typescript-language-server --stdio`    |
| `eslint`                     | JS/TS/Vue diagnostics                                        | `vscode-eslint-language-server --stdio` |
| `json`                       | `.json`, `.jsonc`                                            | `vscode-json-language-server --stdio`   |
| `css`                        | `.css`, `.scss`, `.less`                                     | `vscode-css-language-server --stdio`    |
| `html`                       | `.html`, `.htm`                                              | `vscode-html-language-server --stdio`   |
| `pyright`                    | `.py`, `.pyi`                                                | `pyright-langserver --stdio`            |
| `rust-analyzer`              | `.rs`                                                        | `rust-analyzer`                         |
| `gopls`                      | `.go`                                                        | `gopls`                                 |
| `bash-language-server`       | `.sh`, `.bash`, `.zsh`                                       | `bash-language-server start`            |
| `vue`                        | `.vue`                                                       | `vue-language-server --stdio`           |
| `svelte`                     | `.svelte`                                                    | `svelteserver --stdio`                  |
| `astro`                      | `.astro`                                                     | `astro-ls --stdio`                      |
| `tailwindcss`                | Tailwind project HTML/CSS/JS/TS/Vue/Svelte/Astro files       | `tailwindcss-language-server --stdio`   |
| `clangd`                     | C/C++ headers and sources                                    | `clangd`                                |
| `lua-language-server`        | `.lua`                                                       | `lua-language-server`                   |
| `terraform-ls`               | `.tf`, `.tfvars`                                             | `terraform-ls serve`                    |
| `dockerfile-language-server` | `Dockerfile`, `.dockerfile`                                  | `docker-langserver --stdio`             |
| `yaml`                       | `.yaml`, `.yml`                                              | `yaml-language-server --stdio`          |

The extension does **not** download or install LSP servers. Install them in the project or globally yourself.

Example installs:

```bash
npm install -D typescript typescript-language-server
npm install -D vscode-langservers-extracted eslint
npm install -D pyright
npm install -D bash-language-server yaml-language-server
npm install -D @vue/language-server svelte-language-server @astrojs/language-server
npm install -D @tailwindcss/language-server dockerfile-language-server-nodejs

go install golang.org/x/tools/gopls@latest
# install rust-analyzer via rustup or your package manager
```

## Binary resolution

For Node-based and configured binaries, resolution is:

1. detected LSP root `node_modules/.bin`
2. session `cwd` / workspace ancestors' `node_modules/.bin`
3. pi config root `node_modules/.bin` (for language servers installed once in `~/.pi`)
4. `PATH`

Absolute command paths in config are used as-is. Relative command paths that contain a slash are resolved relative to the detected LSP root.

## Root detection

Each server declares root markers. The extension searches from the target file upward, bounded by the pi session `cwd`.

- Non-strict servers fall back to `cwd` if no marker is found.
- Strict servers require a marker. Currently `rust-analyzer` requires `Cargo.toml`, and `tailwindcss` requires a Tailwind config marker.

## Configuration

Optional global config lives at:

```txt
~/.pi/agent/lsp.json
```

Use it to disable built-ins, override commands, or add custom servers.

Example:

```json
{
	"servers": {
		"typescript": {
			"command": ["typescript-language-server", "--stdio"]
		},
		"eslint": {
			"disabled": true
		},
		"custom-foo": {
			"command": ["foo-lsp", "--stdio"],
			"extensions": [".foo"],
			"rootMarkers": ["foo.toml", ".git"],
			"strictRoot": false,
			"capabilities": {
				"navigation": true,
				"diagnostics": true
			}
		}
	}
}
```

Config fields per server:

- `disabled?: boolean`
- `command?: string[]`
- `env?: Record<string, string>`
- `extensions?: string[]`
- `rootMarkers?: string[]`
- `strictRoot?: boolean`
- `capabilities?: { navigation?: boolean; diagnostics?: boolean }`

If `command` is omitted for a built-in server, the built-in command is used. If `command` is omitted for a custom server, the server is ignored. `env` is only applied when `command` is provided in config.

## Passive synchronization

When a client is already running, successful `read`, `write`, and `edit` tool results sync the touched file into the language server. Passive sync does not prompt or spawn new servers; explicit `lsp` tool calls do that.

Diagnostics are cached in the background but are only sent to the model when it calls `lsp` with `operation: "diagnostics"`.

## Limits and safety

- Query operations are read-only. Mutating operations apply file text edits only after interactive approval.
- Mutating operations use the first available running/matching client that advertises support for the requested provider.
- Results are capped by operation and then truncated using pi's standard output limits.
- Crashed or failed servers are marked broken for the current session and skipped until `/lsp-restart`.
- Clients are session-scoped and shut down on session shutdown/reload/replacement.

## Development

Tests use Vitest and a fake stdio JSON-RPC LSP server fixture:

```bash
npm test
```

The tests cover real tool-to-LSP protocol roundtrips, location formatting, diagnostics, and persisted permissions without depending on external language servers.
