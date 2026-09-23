# TypeScript: Workflows and resources

Apply the [core standards](../typescript.md). Read this reference when its task branch applies.

## Workflows, transactions, and idempotency

Use ordinary function calls or database transactions for simple single-boundary operations.

Use a saga/durable workflow when the process needs:

- retries
- compensation
- idempotency
- resumability
- timers
- human approval
- cross-service coordination
- multiple transaction boundaries

Do not hold database transactions open across network calls or long-running operations.

Any command, job, or workflow step that may be retried needs an explicit idempotency strategy:

- idempotency key
- natural unique constraint
- deduplication record
- state-machine transition guard
- transactional outbox/inbox

Retrying should not rely on “probably safe” side effects.

## Configuration and resources

Parse environment/config at startup or the earliest boundary into typed config with branded/redacted values where appropriate.

Do not read `process.env` throughout the app. Missing/invalid config is a startup failure with useful context.

Avoid top-level side effects except in true entrypoint/bootstrap files. Modules should not start servers, open connections, read env, register handlers, or perform I/O at import time.

Resource creation and cleanup should be explicit and owned by bootstrap/imperative shell code or Effect layers when using Effect.

Avoid mutable singletons/global state. Constants and pure lookup tables are fine. If a singleton is required by a framework/runtime, isolate it at the boundary.

Inject `Clock` / `Random` services into dependency-bearing modules. Pure domain functions may accept explicit `now` / random values.
