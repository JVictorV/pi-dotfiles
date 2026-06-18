# agent/extensions — pi TypeScript extensions

**Generated:** 2026-06-17T13:51:57Z
**Commit:** d8cb9ec

Auto-discovered `*.ts` files, each `export default function (pi: ExtensionAPI)`. Loaded on session start and `/reload`. No build step — pi runs them directly.

## WHERE TO LOOK

| Task                        | File                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| Block/rewrite bash commands | `git-interceptor.ts` (`tool_call` + `isToolCallEventType("bash", event)`) |
| Custom tool registration    | `stack.ts` (registers `stack` tool; `effect` + `Schema`), `lsp/`          |
| Status bar / footer widget  | `statusline.ts` (`belowEditor` widget, registered at `session_start`)     |
| Turn-end side effects       | `notify.ts` (OSC 777 desktop notification)                                |
| Per-turn "working" message  | `whimsical.ts`                                                            |

## CONVENTIONS

- **Tabs, not spaces** — all files indent with tabs, enforced by `oxfmt` (`useTabs`). Run `npm run format` (or `format:check`) from repo root; `npm run lint` runs `oxlint` over this dir.
- Import the API as `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` — runtime-supplied, types only.
- Hook into events via `pi.on("tool_call" | "session_start" | ...)`; return `{ block: true, reason }` to reject a tool call, or mutate `event.input` to rewrite it.
- Use `isToolCallEventType("bash", event)` to narrow before touching `event.input.command`.
- `stack.ts` needs `effect` (`Effect`, `Schema`); `lsp/` needs `vscode-jsonrpc` and `vscode-languageserver-types`. Runtime deps live in root `package.json`.
- Use `effect@beta` for new non-trivial extension logic. Keep any added `@effect/*` packages version-aligned.

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
- **OSC notifications** — `notify.ts` uses OSC 777; unsupported on Kitty/Terminal.app/Alacritty. Don't assume delivery.
- **`any`, unsafe `as` casts, or thrown exceptions in new Effect code** — use typed errors and `Effect.fail`; model failures in the error channel instead.
