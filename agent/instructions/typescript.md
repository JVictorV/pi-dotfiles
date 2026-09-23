# TypeScript coding standards

Read this core before designing, changing, reviewing, or testing TypeScript code.
Apply the task, scope, verification, and communication rules in `~/.pi/agent/AGENTS.md`.
Prefer the project's established conventions unless they conflict with correctness,
safety, or debuggability. Improve the code in scope without forcing a whole-project migration.

## Core principles

- Prefer **errors as values** over `throw` / rejected promises for expected failures.
- Parse early. Do not merely validate and throw away the information learned.
- Make illegal states unrepresentable where practical.
- Prefer correct-by-construction APIs over convention-based invariants.
- Use branded/refined/domain types liberally for meaningful primitives.
- Prefer composition over inheritance.
- Prefer imperative shell / functional core.
- Design deep, cohesive modules with low caller burden.
- Test behavior through real seams; avoid module mocks and spy-driven tests.
- Keep code discoverable for humans and agents.

## Task references

Read the matching references before working on those concerns. For a focused task,
read only the relevant sections. Read several references when the change crosses
concerns; the split changes how standards load, not which standards apply.

- **Errors and data:** For failure handling, schemas, boundary parsing, sensitive data,
  telemetry, brands, optionality, or lifecycle states, read
  [errors-and-data.md](typescript/errors-and-data.md).
- **Module design:** For module interfaces, domain/application structure, dependency
  injection, adapters, persistence boundaries, entrypoints, or authorization placement,
  read [module-design.md](typescript/module-design.md). Creating an adapter or service
  requires its adapter reuse audit, including the ADR rule and its exceptions.
- **Workflows and resources:** For retries, transactions, idempotency, durable workflows,
  configuration, resource ownership, or time/random dependencies, read
  [workflows-and-resources.md](typescript/workflows-and-resources.md).
- **Testing:** For designing, adding, changing, or reviewing tests and test seams,
  read [testing.md](typescript/testing.md). Running an existing check does not require
  reading the test-design reference unless you need to investigate or change its tests.
- **Style and documentation:** For TypeScript edits and code review, read the relevant
  sections of [style.md](typescript/style.md): safety for settings, mutation, casts,
  `any`, and non-null assertions; imports/exports for module access and file layout;
  comments/JSDoc for documentation and exported declarations.

A local implementation change does not require unrelated architecture or workflow
references. If its scope expands, load the newly relevant sections before proceeding.

## Adapting to existing codebases

Before adding a new pattern or library, inspect the repo for existing choices around:

- error handling
- schema parsing
- dependency injection
- testing
- observability
- adapters/services
- module layout

Prefer consistency inside the codebase. If existing code uses exception-style errors, do not rewrite the whole system. New code may still use typed results internally, but it must integrate with existing framework handlers, logging, tracing, metrics, and error reporting.

At boundaries, translate between local typed errors and whatever the framework or existing code expects.
