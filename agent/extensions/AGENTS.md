# agent/extensions — pi TypeScript extensions

Pi discovers `*.ts` files and `*/index.ts` directory entrypoints. Each exports an extension factory. Source changes load on session start or `/reload`; after a dependency upgrade, restart Pi to avoid retaining old dependency modules.

## WHERE TO LOOK

| Task                        | File                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Block/rewrite bash commands | `git-interceptor.ts` (`tool_call` + `isToolCallEventType("bash", event)`)                     |
| Custom tool registration    | `lsp/`                                                                                        |
| Context resets and history  | `smart-context/` ([behavior and recovery](smart-context/README.md))                           |
| Tool result safety          | `tool-result-sanitizer.ts` (guards provider-legal errored tool results)                       |
| Status line                 | `statusline/` ([ADR](../../docs/adr/0001-modular-effect-first-status-line.md))                |
| Desktop notifications       | `notify.ts` ([setup and platform limits](../../README.md#desktop-notifications--sound-macos)) |
| Per-turn "working" message  | `whimsical.ts`                                                                                |

## CONVENTIONS

- **Tabs, not spaces** — all files indent with tabs, enforced by `oxfmt` (`useTabs`). Run `npm run format` (or `format:check`) from repo root; `npm run lint` runs `oxlint` over this dir.
- Import the API as `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` — runtime-supplied, types only.
- Hook into events via `pi.on("tool_call" | "session_start" | ...)`; return `{ block: true, reason }` to reject a tool call, or mutate `event.input` to rewrite it.
- Use `isToolCallEventType("bash", event)` to narrow before touching `event.input.command`.
- `lsp/` needs `vscode-jsonrpc` and `vscode-languageserver-types`. Runtime deps live in root `package.json`.
- Use the root-pinned Effect version for non-trivial extension logic. Keep `@effect/*` packages version-aligned.

## EFFECT

Use Effect for async workflows, typed errors, dependency injection, resource management, retries, testing, and observability.

Preferred patterns:

- Prefer `Effect.fn` for reusable business logic that returns `Effect`.
- Use typed errors with `Effect.fail`, `Effect.catchTag`, and schema-defined errors where useful.
- Use services and layers when dependencies grow beyond a small local helper.
- Consult the Effect skill references and `.repos/effect` before implementing complex Effect patterns.

## ANTI-PATTERNS

- **Spawning interactive subprocesses** — they hang the agent. `git-interceptor` already forces `GIT_EDITOR=true`; don't undo it.
- **Allowing `--no-verify`** — `git-interceptor` blocks it deliberately; never add an escape hatch.
- **Widget placement matters** — `statusline` registers as a `belowEditor` widget at `session_start`. Don't move it unless you want it in another UI region.
- **Assuming desktop notification delivery** — `notify.ts` depends on host-specific tools. Check the implementation and root README before changing notification setup.
- **`any`, unsafe `as` casts, or thrown exceptions in new Effect code** — use typed errors and `Effect.fail`; model failures in the error channel instead.
