# LSP Promise-to-Effect Map

Goal: make LSP internals Effect-native. Promise usage should be limited to pi/plugin boundary functions that adapt Effects to pi's async APIs.

Boundary functions allowed to consume promises:

- `agent/extensions/lsp/index.ts`
  - `session_start`, `session_shutdown`, `tool_result` handlers
  - command handlers registered with pi
- `agent/extensions/lsp/tool.ts`
  - `execute` callback registered with `pi.registerTool`
- JSON-RPC library callbacks may return promises only where `vscode-jsonrpc` requires callback results.

## Current promise sites

### Boundary / allowed last

| File       | Promise sites                                         | Target                                                                                                   |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `index.ts` | event and command handlers, currently `async`/`await` | Keep as Promise boundary, but only call `Effect.runPromise(...)` inside.                                 |
| `tool.ts`  | registered tool `execute` and helper chain            | Keep `execute` as Promise boundary; move helpers to Effects and run one top-level Effect from `execute`. |

### Runtime orchestration

| File         | Promise sites                                                                                                                     | Target                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts` | public `restart`, `shutdown`, `clientsForFile`, `touchRunningFile`; private promise helpers for spawn, matching, permission, sync | Replace private promise helpers with Effect workflows. Public methods either become Effect APIs or remain thin Promise adapters only while callers migrate. |
| `runtime.ts` | `sessionRuntime.runPromise`, `ManagedRuntime.dispose`                                                                             | Keep only at boundary/adapters. Internal session methods should compose Effects.                                                                            |
| `runtime.ts` | `Promise.all` for shutdown/restart/touch                                                                                          | Replace with `Effect.forEach(..., { concurrency: "unbounded" })` or sequential `Effect.forEach`.                                                            |

### Client / JSON-RPC integration

| File        | Promise sites                                                                                   | Target                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.ts` | `LspClient.create`, `open`, `request`, `shutdown`, diagnostics pull/wait helpers, notifications | Convert to Effect-returning methods. Wrap JSON-RPC `sendRequest`/`sendNotification` and fs reads with `Effect.tryPromise`.                       |
| `client.ts` | `withTimeout`, `wait`, `new Promise` listener waits                                             | Replace with Effect timeout/sleep/async helpers.                                                                                                 |
| `client.ts` | `SafeMessageWriter.write` and stream write queue                                                | Leave as Promise-returning adapter because `vscode-jsonrpc` `MessageWriter` interface requires promises. Internals can use small Promise bridge. |
| `client.ts` | `connection.onRequest(async ...)` handlers                                                      | Allowed JSON-RPC callback boundary; return immediate values where possible.                                                                      |

### Server discovery/spawn

| File        | Promise sites                                                                   | Target                                                                                                              |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `server.ts` | executable lookup, node module resolution, root detection, spawn spec callbacks | Convert to Effect-returning functions and `LspServerDefinition.spawn` Effect. Use `Effect.tryPromise` for `access`. |
| `server.ts` | child process `spawn`                                                           | Synchronous Node call can stay `Effect.sync`; errors wrapped in typed failures later if needed.                     |

### Config, paths, permissions

| File             | Promise sites                                      | Target                                                                                  |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `config.ts`      | `loadLspConfig` fs read                            | Convert to `loadLspConfigEffect`. Boundary uses `Effect.runPromise`.                    |
| `paths.ts`       | `canonicalPath`, `findRepositoryRoot`              | Convert to Effect helpers.                                                              |
| `permissions.ts` | load/read/write/set/reset and semaphore write lock | Convert store API to Effect. Keep semaphore; remove `Effect.runPromise` from internals. |

## Conversion order

1. `paths.ts` + `config.ts` + `permissions.ts`: lowest-risk fs helpers.
2. `server.ts`: executable/root/spawn discovery as Effects.
3. `client.ts`: JSON-RPC request/open/shutdown/diagnostic workflows as Effects; keep only MessageWriter adapter promises.
4. `runtime.ts`: remove remaining private Promise helpers and compose client/server/permission Effects directly.
5. `tool.ts`: move helper pipeline into one Effect program and leave only registered `execute` as Promise adapter.
6. `index.ts`: leave as plugin boundary, calling Effects via `Effect.runPromise` only.

## Tracking

- [x] Slice 1: fs/config/permission helpers
  - `paths.ts`, `config.ts`, and `permissions.ts` now expose Effect workflows.
  - `index.ts` consumes those workflows only at pi command/session boundaries via `Effect.runPromise`.
  - Temporary adapters remain in `runtime.ts` and `server.ts` until their slices are converted.
- [x] Slice 2: server discovery/spawn
  - `server.ts` executable lookup, node module resolution, root detection, and spawn construction now return Effects.
  - `LspServerDefinition.spawn` is Effect-based.
  - Temporary `Effect.runPromise` adapters remain in `runtime.ts` until runtime workflows are converted.
- [ ] Slice 3: client workflows
- [x] Slice 4: runtime workflows
  - `runtime.ts` private orchestration now composes Effect workflows directly for restart, shutdown, client resolution, file touch, matching, permission, and spawn.
  - Remaining Promise surface in `runtime.ts` is the public compatibility adapter (`restart`, `shutdown`, `clientsForFile`, `touchRunningFile`) plus temporary `Effect.tryPromise` bridges to `LspClient` until Slice 3 lands.
- [ ] Slice 5: tool program
- [ ] Slice 6: boundary cleanup
