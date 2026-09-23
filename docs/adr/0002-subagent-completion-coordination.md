# Subagent completion coordination

One module owns completion-arm preparation, action ordering, notification decisions,
and failed-send recovery. The Pi tool adapter submits actions and presents results;
it does not reserve notification batches, prepare watchers, or decide whether an
in-flight action already delivered a completion.

## Considered options

- Keep coordination split between the tool adapter, action module, and notification module.
- Move the tool callback without changing its ordering obligations.
- Concentrate completion coordination while reusing the existing transport and notification modules.

The third option removes caller obligations without replacing the Herdr SDK adapter,
registry, RPC/outbox transport, or notification grouping implementation. These existing
modules already provide the required capabilities. No new transport adapter is needed.

## Consequences

Completion acceptance must be ready before input can produce a result. A completion
that arrives before a successful send returns must not cause a second watcher to be
armed. An ambiguous send failure restores the previous durable arm but preserves
acceptance of the attempted arm: transport failure does not prove that input was
rejected.

Action-level tests are the main test surface for these ordering rules. Keep focused
notification tests for independent grouping and deduplication behavior, and use the
existing local Herdr protocol adapter and temporary files for action verification.
