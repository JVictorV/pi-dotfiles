# TypeScript: Module design

Apply the [core standards](../typescript.md). Read this reference when its task branch applies.

## Modules and abstractions

### Deep modules

A deep module hides substantial behavior/invariants behind a cohesive, low-burden interface. Low-burden does not necessarily mean few functions. A domain module may expose many cohesive combinators around one concept and still be deep.

Avoid shallow abstractions that merely forward calls, mirror tables, or expose implementation steps.

Use the deletion test:

- if deleting the module makes complexity disappear, it was probably pass-through waste
- if deleting it spreads complexity across callers, it was probably earning its keep

### Domain modules

Prefer OCaml-style domain modules for core concepts. A domain module centers on one primary type or tightly related type family and exposes parsers, smart constructors, combinators, predicates, interpreters, arbitraries, and formatting helpers for that concept.

Example:

```ts
// email-address.ts

/** A parsed, normalized email address. */
export type EmailAddress = Brand<string, "EmailAddress">;

/** Parse an email address from untrusted input. */
export function parse(input: string): Result<EmailAddress, InvalidEmailAddress>;

/** Render an email address as a string. */
export function toString(email: EmailAddress): string;

/** Compare two email addresses for equality. */
export function equals(left: EmailAddress, right: EmailAddress): boolean;
```

Domain modules may be plain functions, classes, or static-style classes when cohesive.

If using classes for domain values:

- construct through `parse` / `make` / smart constructors
- make invalid instances unconstructable
- keep fields readonly/immutable from callers
- keep methods cohesive over that value
- do not hide dependencies or I/O inside domain value classes
- avoid inheritance for domain behavior

### Application/service modules

Application modules own real capabilities or operations:

- `PasswordReset`
- `Billing`
- `Invitations`
- `SubscriptionLifecycle`

They coordinate domain modules, persistence, external calls, authorization, workflows, and telemetry.

Prefer classes with constructor injection when the module has dependencies, stateful resources, configuration, or multiple cohesive operations.

Avoid dependency bags like `deps` objects passed into every function. In Effect codebases, use Effect services/tags/layers instead.

No arbitrary method limit. Split when methods are unrelated, change for different reasons, require unrelated dependencies, or create an accidental grab bag.

Avoid vague names like `Manager`, `Processor`, `Helper`, or generic `UserService` unless established by the framework/project.

## Dependency interfaces and adapters

Depend on the smallest meaningful shape a module actually uses. Let concrete adapters be wider.

Because TypeScript is structurally typed, this works well:

```ts
type UsersForPasswordReset = {
	findActiveByEmail(email: EmailAddress): Promise<Result<ActiveUser, UserLookupError>>;
};

export class PasswordReset {
	constructor(private readonly users: UsersForPasswordReset) {}
}
```

A wider adapter can satisfy it:

```ts
export class PostgresUsers {
  findActiveByEmail(...) { ... }
  findById(...) { ... }
  updateProfile(...) { ... }
}
```

This avoids both mega-repositories and one-method adapter sprawl.

### Adapter reuse audit

Before creating a new adapter or service, agents must audit existing adapters/services.

Prefer, in order:

1. Reuse an existing adapter as-is through a narrow dependency type.
2. Extend an existing adapter if the new method fits its existing cohesive capability and changes for the same reason.
3. Create a new adapter only when reuse/extension would create bad coupling or an accidental interface.

When a meaningful new adapter/service is still created after the audit, create an ADR explaining:

- what existing adapters/services were checked
- why reuse did not fit
- why extension did not fit
- why the new adapter is a separate cohesive capability

Do not require an ADR for tiny local test adapters, obvious in-memory fakes, or trivial framework glue.

### Repositories and persistence

Avoid repository-per-table by default.

Repository-like adapters are acceptable when they represent a cohesive domain persistence capability. They should expose meaningful domain operations and return parsed domain types / typed errors, not raw rows and ORM errors.

Treat raw database rows and ORM models as infrastructure DTOs. Parse them before application/core logic. Keep SQL/ORM details inside infrastructure adapters or persistence modules.

## Functional core, imperative shell, and entrypoints

Keep domain/application behavior reusable across REST, CLI, GraphQL, workers, and other entrypoints.

The functional core contains:

- domain logic
- parsers
- state transitions
- combinators
- decision functions

It avoids:

- I/O
- hidden dependencies
- ambient time/randomness
- thrown expected failures
- framework-specific concerns

The imperative shell:

- parses untrusted input
- sequences effects
- calls the core with refined values
- classifies external failures into typed errors
- handles I/O, persistence, HTTP, queues, telemetry, time, randomness

Entrypoint adapters should be thin protocol translation layers. They parse protocol-specific input, invoke shared modules, and render protocol-specific output. Do not duplicate business rules in controllers/resolvers/CLI handlers.

Authorization belongs in shared application/domain policy, not duplicated in controllers. Entrypoints may authenticate and parse users/sessions/credentials, but shared modules should receive a domain-specific parsed authorization input such as `AdminUser`, `Session`, `Principal`, `DeployCredential`, or `CommandActor`.
