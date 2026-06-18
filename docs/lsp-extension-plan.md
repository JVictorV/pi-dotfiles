# LSP Extension Plan

We are building LSP support as a global pi extension under `agent/extensions/lsp/`, adapting the core architecture from `anomalyco/opencode` without importing from the `.repos/opencode` submodule at runtime.

## Decisions

- **Extension boundary**: Implement as a pi extension, not a pi core change.
- **Porting strategy**: Copy/adapt opencode's LSP shape—server catalog, lazy client spawning, JSON-RPC client, diagnostics cache, and an LLM-callable `lsp` tool—while replacing opencode-specific services with pi extension APIs.
- **Dependencies**: Add low-level LSP protocol dependencies (`vscode-jsonrpc`, `vscode-languageserver-types`) rather than implementing JSON-RPC framing manually.
- **Phase 1 scope**: Expose read-only code intelligence and diagnostics only: definition, references, hover, document symbols, workspace symbols, implementation, call hierarchy, and diagnostics.
- **Spawn permission**: Confirm before starting an LSP server for a repository, then store the user's `allow` or `deny` preference globally per repository absolute path so future sessions do not repeat the prompt. Provide commands to inspect, allow, deny, and reset preferences.
- **Server configuration**: Read server overrides and custom servers from a dedicated global `agent/lsp.json` file, not from pi `settings.json`.
- **Built-in server catalog v1**: Include a curated opencode-style registry for TypeScript/JavaScript, ESLint, JSON, CSS/HTML, Python, Rust, Go, Shell, and YAML. Exclude Lua initially. Keep registry entries small and modular so additional servers are easy to add.
- **Server installation**: Do not download or install LSP servers automatically in v1. Only use project-local binaries, globally available binaries on `PATH`, or known installed toolchain binaries, and return install hints when a server is missing.
- **Passive synchronization**: Hook successful `read`, `write`, and `edit` tool results so already-running/allowed LSP clients stay in sync with files the agent reads or changes. Passive sync must not trigger permission prompts; explicit `lsp` tool calls are what may prompt and spawn servers.
- **Tool interface**: Expose one general `lsp` tool with an `operation` enum, following opencode's shape, instead of many per-operation tools.
- **Tool coordinates**: Accept 1-based line and character inputs, matching editor-visible positions, and convert internally to raw LSP 0-based positions. Document that LSP character offsets are UTF-16 code units.
- **Result formatting**: Return concise model-friendly text in tool `content`, with normalized structured data in `details` for rendering/debugging. Avoid raw JSON-only results and apply truncation to large outputs.
- **Root detection**: Detect each server root using the nearest configured marker from the target file upward, bounded by the pi session `cwd`. Fall back to `cwd` for non-strict servers; strict servers require a marker.
- **Client selection**: Registry entries declare capabilities. Navigation/symbol operations use matching navigation-capable clients; diagnostics aggregate matching diagnostics-capable clients. Do not blindly query lint-only servers for navigation.
- **Diagnostics lifecycle**: Keep diagnostics caches fresh through passive synchronization, but only send diagnostics to the model when it explicitly calls the `lsp` diagnostics operation. Do not inject diagnostics automatically after every edit/write in v1.
- **Human commands**: Provide minimal slash commands in v1: `/lsp-status`, `/lsp-permissions`, `/lsp-allow <server>`, `/lsp-deny <server>`, `/lsp-reset <server|all>`, and `/lsp-restart <server|all>`.
- **Binary resolution**: Resolve language server binaries from project-local `node_modules/.bin` first (detected root, then session `cwd`/workspace ancestors), then fall back to `PATH`.
- **Activation**: Keep the `lsp` tool active by default. It is read-only in v1, spawning is permission-gated, and prompt guidance should tell the model to prefer `lsp` over grep for semantic relationships.
- **Client lifecycle**: Keep LSP clients session-scoped in v1. Start lazily on explicit `lsp` queries, reuse within the current pi session, and shut down on session shutdown/reload/replacement. Persist permissions/config only, not live clients.
- **Result limits**: Apply operation-specific caps before formatting (`workspaceSymbol` 50, `references` 100, `documentSymbol` 200, diagnostics 200, call hierarchy 100 by default), support an optional tool `limit`, and still apply pi's standard line/byte truncation to final text output.
- **Error posture**: Explicit `lsp` tool calls should fail visibly for missing binaries, initialization failures, crashes, malformed responses, and unavailable servers. Mark failed `{repo root, server id}` pairs as broken for the current session and skip them until `/lsp-restart`; passive sync should ignore failures without prompting.
- **Phase 2 scope**: Add mutating LSP actions later—rename, code actions, formatting, organize imports, and workspace edits—only after designing preview, confirmation, and file mutation queue integration.

## Rationale for read-only v1

Read-only LSP operations are immediately useful and low risk. Mutating LSP actions can apply multi-file edits and generated changes, so they need careful safeguards before being available to the model.
