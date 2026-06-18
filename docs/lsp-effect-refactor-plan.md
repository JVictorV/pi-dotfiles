# LSP Effect Refactor Plan

This is the working plan for refactoring `agent/extensions/lsp/` toward safer Effect-managed lifecycle, idempotency, diagnostics, and error handling.

## References read

- `agent/extensions/lsp/README.md` — current extension contract and documented limits.
- `.repos/opencode/packages/opencode/src/lsp/lsp.ts` — singleflight spawning, state shape, finalizers, operation dispatch.
- `.repos/opencode/packages/opencode/src/lsp/client.ts` — dynamic diagnostics, pull/push diagnostic merging, document sync, shutdown.
- `.repos/opencode/packages/opencode/src/lsp/server.ts` — registry/root/spawn patterns and broader server catalog.
- `.repos/effect/LLMS.md` — local Effect style guide (`Effect.fn`, tagged errors, services/layers, scopes).
- `.repos/effect/ai-docs/src/01_effect/04_resources/10_acquire-release.ts` — scoped resource acquisition/release.
- `.repos/effect/ai-docs/src/03_integration/10_managed-runtime.ts` — `ManagedRuntime` bridge from imperative APIs.
- `.repos/effect/packages/effect/src/Deferred.ts` — one-time coordination cell for singleflight waiters.
- `.repos/effect/packages/effect/src/SynchronizedRef.ts` — serialized effectful state transitions.
- `.repos/effect/packages/effect/src/Semaphore.ts` — scoped concurrency guards for client document sync.
- `.repos/effect/packages/effect/src/Scope.ts` — lifecycle boundary and finalizers.

## Ground rules

- Work in vertical slices: one failing behavior test, then the smallest implementation that passes.
- Keep the pi extension public surface stable unless a later step explicitly documents a change.
- Prefer integration-style tests through `LspRuntime` / registered `lsp` tool behavior.
- After each slice, update this file with status, decisions, and next action.
- Run at least `npm test` and `npm run typecheck` after each completed slice.

## Target architecture

Eventually, the imperative `LspRuntime` should become a thin bridge over an Effect service/layer:

- Effect service owns session state and client lifecycle.
- `ManagedRuntime` bridges tool/command Promise APIs to Effect programs.
- Clients are scoped resources acquired with `Effect.acquireRelease`.
- Shared mutable state is behind `Ref` / `SynchronizedRef`.
- Spawn idempotency uses `Deferred` singleflight cells keyed by `{root, serverId}`.
- Shutdown/restart are idempotent and never surface cleanup failures to callers.
- Request failures are typed and do not automatically poison a client unless the transport/process is actually broken.

## Work queue

### Slice 1 — Singleflight spawning and prompt idempotency

**Behavior:** Concurrent LSP requests for the same file/server/root should share one permission prompt and one spawn attempt.

**Why first:** This directly addresses idempotency/race crashes without forcing the full service rewrite up front.

**Plan:**

- Add an integration test that fires concurrent `hover` requests through the registered `lsp` tool.
- Expect one permission prompt and one running client.
- Implement a `spawning` map in `LspRuntime` using Effect `Deferred`.
- Set the in-flight cell before permission/spawn so prompt itself is singleflighted.

**Status:** Done.

**Notes:**

- Added `LspRuntime.spawning`, keyed by `{root}\0{serverId}`, using Effect `Deferred` cells.
- The in-flight cell is installed before permission prompting, so concurrent callers share both the permission decision and spawn attempt.
- `restart()` and `shutdown()` clear stale in-flight cells for their scope.
- Added regression coverage: `concurrent LSP requests share one spawn permission decision`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 2 — Shutdown during in-flight spawn

**Behavior:** shutdown/restart can be called while a client is starting, including after the process has exited or stdio has closed, without leaving an installed zombie client.

**Plan:**

- Add a fake-server initialization delay to create an in-flight spawn window.
- Add an integration test that starts a tool request, shuts the runtime down during initialization, and verifies the request rejects plus runtime status stays empty.
- Move cleanup errors into swallowed/loggable cleanup paths.
- Prepare for `Effect.acquireRelease` by making shutdown paths total and idempotent.

**Status:** Done.

**Notes:**

- Added a shutdown guard at `clientsForFile` entry and after permission/spawn awaits.
- `spawnClient` now shuts down a freshly-created client instead of installing it if runtime shutdown won the race.
- In-flight callers receive `LSP runtime is shutting down.` instead of a successful tool result from a torn-down session.
- Added regression coverage: `shutdown prevents in-flight spawns from installing clients`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 3 — Typed LSP errors

**Behavior:** tool errors should be predictable and classified; existing human-readable messages remain useful.

**Plan:**

- Add `agent/extensions/lsp/errors.ts` with `Schema.TaggedErrorClass` errors.
- Convert config/permission/spawn/init/request/unsupported/malformed/no-client paths gradually.
- Tool formatting catches typed errors at the boundary when needed.

**Status:** Done for planned typed boundary errors.

**Notes:**

- Added the typed error taxonomy in `agent/extensions/lsp/errors.ts`:
  - `LspConfigError`
  - `LspPermissionDenied`
  - `LspBinaryMissing`
  - `LspSpawnError`
  - `LspInitializeError`
  - `LspRequestTimeout`
  - `LspRequestError`
  - `LspClientBroken`
  - `LspNoClients`
  - `LspUnsupportedOperation`
  - `LspMalformedResponse`
  - `LspShutdownError`
  - `LspRuntimeShuttingDown`
- Converted the shutdown race path to throw `LspRuntimeShuttingDown` and updated the regression test to assert the typed `_tag` + `reason`.
- Permission denied, missing binary, and initialize failures now surface as typed public-boundary errors where a single unavailable server explains the failure.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 4 — Do not mark clients broken for ordinary request errors

**Behavior:** A request timeout or unsupported method should fail that operation but leave the client usable.

**Plan:**

- Add fake server modes for request timeout/error.
- Test that a failed request is followed by a successful hover without `/lsp-restart`.
- Mark broken only on process exit / transport unusable / initialization failure.

**Status:** Done for request errors and timeout wrapping.

**Notes:**

- Added `FAKE_LSP_HOVER_ERROR_COUNT` to the fake LSP server.
- Added regression coverage: `request errors do not mark language servers broken`.
- Changed `LspClient.request()` so JSON-RPC request failures no longer mark the client broken. The preflight `canSend()` path still marks broken when the transport/process is already unusable.
- Request timeouts now wrap as `LspRequestTimeout`; request failures wrap as `LspRequestError`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 4.5 — Permission store concurrent writes

**Behavior:** Concurrent allow/deny preference writes should not race on the same temp file or lose entries.

**Why now:** The first concurrent request test exposed a permission temp-file race before singleflight hid it for same-server spawns. Different servers can still write preferences concurrently.

**Plan:**

- Add a behavior test that performs concurrent `LspPermissionStore` writes through separate loaded store instances.
- Expect both preferences to be present after reload.
- Serialize permission-file mutations with an Effect `Semaphore`.
- Reload latest disk state under the lock before merging the mutation so concurrent writers do not clobber each other.

**Status:** Done.

**Notes:**

- Added regression coverage: `permission store preserves concurrent writes`.
- Reworked `LspPermissionStore` saves around an Effect `Semaphore`.
- Each mutation reloads latest disk state while holding the lock, applies its change, and writes via a unique temp file path.
- This fixes both the temp-file collision and lost-update risks for concurrent store instances.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 4.6 — State-driven status notifications

**Behavior:** Runtime state changes should notify the extension immediately, instead of relying on a later `tool_result` hook to refresh status.

**Plan:**

- Add a runtime-level callback test proving client spawn triggers a status notification.
- Add optional `onStatusChange` to `LspRuntime`.
- Call it after spawn, restart, shutdown, and broken-client transitions.
- Wire `lsp/index.ts` to emit `lsp:status` from the runtime callback.

**Status:** Done.

**Notes:**

- Added regression coverage: `runtime notifies when LSP client status changes`.
- Added optional `onStatusChange` to `LspRuntime` and wired `lsp/index.ts` to emit `lsp:status` from runtime state changes.
- Runtime now notifies on client spawn, restart removal, shutdown clearing, and broken-client transitions.
- Removed the old `lsp` tool-result status fallback after the service bridge; passive file sync remains in `tool_result`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 4.7 — Typed tool boundary errors

**Behavior:** Common tool failure modes should reject with typed LSP errors instead of anonymous `Error` objects.

**Plan:**

- Convert malformed response, unsupported operation, and no-client failures to the typed error taxonomy.
- Update tests to assert `_tag` and `reason` while preserving useful reason text.

**Status:** Done for common tool boundary failures.

**Notes:**

- Converted malformed location responses to `LspMalformedResponse`.
- Converted unsupported operation failures to `LspUnsupportedOperation`.
- Converted no-client failures to `LspNoClients`.
- Updated regression tests to assert typed `_tag` + `reason`.
- Added typed public-boundary errors for denied permissions (`LspPermissionDenied`), missing binaries (`LspBinaryMissing`), initialize failures (`LspInitializeError`), and generic spawn failures (`LspSpawnError`).
- Added typed config parse errors (`LspConfigError`) and regression coverage: `invalid LSP config fails with typed config error`.
- Added typed request error/timeout wrapping (`LspRequestError`, `LspRequestTimeout`) and updated request-error regression coverage.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 5 — Effect service bridge

**Behavior:** Existing public `LspRuntime` methods still work, but implementation runs through an Effect service/layer.

**Plan:**

- Introduce `LspSession` service with methods mirroring `LspRuntime`.
- Use `ManagedRuntime.make(LspSession.layer(...))` per pi session.
- Move maps into `SynchronizedRef` state.
- Keep current `LspRuntime` as compatibility wrapper.

**Status:** Done for the compatibility-wrapper architecture.

**Notes:**

- Added `LspRuntimeSession` Effect service in `runtime.ts`.
- Public `LspRuntime` methods enter through a `ManagedRuntime` service layer.
- Runtime state lives behind a `SynchronizedRef` state object.
- Service methods now return named `Effect` workflows instead of delegating through private `*Unsafe` helpers.
- `LspRuntime` remains as the stable compatibility wrapper for tool and command callers.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 6 — Diagnostics parity with opencode

**Behavior:** Diagnostics are stable across push and pull diagnostic servers.

**Current sub-slice:** Add dynamic diagnostic registration and workspace diagnostics.

**Plan:**

- Port dynamic registration tracking.
- Add pull diagnostics (`textDocument/diagnostic`, `workspace/diagnostic`).
- Merge/dedupe push + pull diagnostics.
- Replace fixed settle sleep with wait helpers.

**Status:** Done for planned v1 parity.

**Notes:**

- Added fake-server support for pull-only diagnostics via `textDocument/diagnostic`.
- Added regression coverage: `diagnostics operation supports document pull diagnostics`.
- `LspClient.open(..., waitForDiagnostics: true)` now requests document pull diagnostics when the server advertises `diagnosticProvider`.
- Pull results merge with existing pushed diagnostics and dedupe by `{code,severity,message,source,range}`.
- Added dynamic diagnostic registration tracking for `client/registerCapability` / `client/unregisterCapability`.
- Added regression coverage: `diagnostics operation supports dynamic document diagnostic registration`.
- Added workspace pull diagnostics through dynamic `workspaceDiagnostics` registrations.
- Added regression coverage: `diagnostics operation supports workspace pull diagnostics`.
- Added wait-for-fresh pushed diagnostics using publish-diagnostic listeners instead of relying only on fixed settle sleeps.
- Added regression coverage: `diagnostics operation waits for fresh pushed diagnostics`.
- Remaining diagnostic parity polish: richer registration timing/backoff like opencode, but v1 behavior is covered.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 7 — Document sync parity with opencode

**Behavior:** Open/change notifications match server sync capabilities and file watcher expectations.

**Current sub-slice:** Expand language-id mapping for additional common file types.

**Plan:**

- Expand language id mapping.
- Track server `textDocumentSync` mode.
- Send `workspace/didChangeWatchedFiles` create/change events.
- Use incremental full-file replacement when sync mode is incremental.

**Status:** Done for planned v1 parity.

**Notes:**

- Added fake-server watched-file reporting for document sync tests.
- Added regression coverage: `document sync sends watched-file create and change notifications`.
- `LspClient.open()` now sends `workspace/didChangeWatchedFiles` with create before first `didOpen` and change before subsequent `didChange`.
- Added fake-server incremental-sync enforcement and regression coverage: `document sync honors incremental text document sync mode`.
- `LspClient.open()` now honors numeric/object `textDocumentSync` change mode and sends a full-document replacement range when the server requests incremental sync.
- Expanded language-id mapping for common file types and added regression coverage: `document open uses language ids for common file types`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

### Slice 8 — Status events from state transitions

**Behavior:** statusline updates whenever runtime state changes, not just after explicit `lsp` tool results.

**Plan:**

- Publish status after spawn, broken transition, restart, shutdown.
- Remove special status emission from `tool_result` if no longer needed.

**Status:** Done.

**Notes:**

- Runtime-level status notifications are implemented and wired to `lsp:status`.
- Removed the old `lsp` tool-result status fallback; passive file sync remains in `tool_result`.

## Decisions

- Do not start with a large rewrite. First land race/lifecycle behavior improvements in the current class shape, while introducing Effect primitives where they directly solve a problem.
- `Deferred` is the first Effect primitive to introduce because it maps exactly to spawn singleflight and keeps the public Promise API unchanged.

## Next action

Remaining follow-ups are now product backlog rather than runtime hardening blockers:

1. Split the current compatibility-wrapper runtime into smaller Effect service modules for readability.

## Expanded built-in server registry

**Status:** Done.

**Notes:**

- Added built-in server definitions for Vue, Svelte, Astro, Tailwind CSS, clangd, Lua, Terraform, and Dockerfile projects.
- Tailwind is strict-rooted to Tailwind config markers to avoid prompting in every JS/TS project.
- Updated LSP README built-in server table and install examples.
- Added registry coverage for the expanded server IDs.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

## Mutating LSP operations

**Status:** Done.

**Notes:**

- Added approved mutating `lsp` operations: `rename`, `codeAction`, `formatting`, and `organizeImports`.
- Mutations request edits from the LSP server first, then require explicit UI confirmation before writing files.
- `codeAction` without `actionTitle` lists available actions without mutating; with `actionTitle`, it applies the matching workspace edit.
- Workspace edits support `changes` and text-edit `documentChanges` for file URIs.
- Changed files are re-synced to running LSP clients after application.
- Added regression coverage for rename, code-action listing/application, formatting, and organize imports.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.

## Lifecycle extras

**Status:** Done.

**Notes:**

- `LspClient.open()` sends `textDocument/didSave` after first open and after changed content is synced.
- `LspClient.shutdown()` sends `textDocument/didClose` for open documents before the server shutdown request.
- `LspRuntime.shutdown()` now requests `ManagedRuntime` disposal only after active operations drain, avoiding interruption of in-flight tool calls while still allowing post-shutdown status reads.
- Added regression coverage: `client shutdown sends save and close lifecycle notifications`.
- Validation: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.
