# agent/extensions — pi TypeScript extensions

**Generated:** 2026-06-17T13:51:57Z
**Commit:** d8cb9ec

Auto-discovered `*.ts` files, each `export default function (pi: ExtensionAPI)`. Loaded on session start and `/reload`. No build step — pi runs them directly.

## WHERE TO LOOK

| Task                        | File                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| Block/rewrite bash commands | `git-interceptor.ts` (`tool_call` + `isToolCallEventType("bash", event)`) |
| Custom tool registration    | `stack.ts` (registers `stack` tool; `effect` + `Schema`)                  |
| Status bar / footer widget  | `statusline.ts` (`belowEditor` widget, registered at `session_start`)     |
| Turn-end side effects       | `notify.ts` (OSC 777 desktop notification)                                |
| Per-turn "working" message  | `whimsical.ts`                                                            |

## CONVENTIONS

- **Tabs, not spaces** — all files indent with tabs, enforced by `oxfmt` (`useTabs`). Run `npm run format` (or `format:check`) from repo root; `npm run lint` runs `oxlint` over this dir.
- Import the API as `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` — runtime-supplied, types only.
- Hook into events via `pi.on("tool_call" | "session_start" | ...)`; return `{ block: true, reason }` to reject a tool call, or mutate `event.input` to rewrite it.
- Use `isToolCallEventType("bash", event)` to narrow before touching `event.input.command`.
- `stack.ts` needs `effect` (`Effect`, `Schema`) — the only extension with a real runtime dep; it lives in root `package.json`.

## ANTI-PATTERNS

- **Spawning interactive subprocesses** — they hang the agent. `git-interceptor` already forces `GIT_EDITOR=true`; don't undo it.
- **Allowing `--no-verify`** — `git-interceptor` blocks it deliberately; never add an escape hatch.
- **Widget registration order matters** — `statusline` registers at `session_start` so it sits above the pi-lens bar (later registrant renders lower). Don't move its registration.
- **OSC notifications** — `notify.ts` uses OSC 777; unsupported on Kitty/Terminal.app/Alacritty. Don't assume delivery.
