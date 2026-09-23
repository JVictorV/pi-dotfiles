# TypeScript: Errors and data

Apply the [core standards](../typescript.md). Read this reference when its task branch applies.

## Errors and failures

### Expected failures are values

Expected failures include domain, parsing, authorization, integration, I/O, persistence, and workflow failures. They should appear in the return type.

Preferred order:

1. Effect, when the codebase already uses Effect.
2. `better-result`, when available and appropriate.
3. A small local tagged union:

```ts
type Result<T, E extends Error> =
	{ readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E };
```

Prefer:

```ts
Promise<Result<User, UserLookupError>>;
```

not:

```ts
Promise<User>; // rejects for ordinary lookup/storage failures
```

Promise rejection is equivalent to throwing. Treat it as acceptable only for unrecoverable defects or unclassified third-party behavior at a boundary.

### Unrecoverable defects may throw

Throwing is acceptable for panic-style failures:

- violated internal invariants
- impossible branches
- startup misconfiguration
- temporary `notYetImplemented` paths
- catastrophic runtime conditions

Use shared helpers from `prelude.ts` where available:

```ts
export function casesHandled(unexpectedCase: never): never;
export function shouldNeverHappen(msg?: string): never;
export function notYetImplemented(msg?: string): never;
```

Use `casesHandled` for exhaustive union handling. Avoid names like `absurd` or one-off `assertNever` helpers when the project already has these helpers.

### Custom errors

Expected failures should use custom tagged errors, generally extending:

- `Error`
- `TaggedError` from `better-result`
- Effect's schema-defined tagged errors, using the constructor available in the project's pinned version

Custom errors should include:

- stable tag
- useful message
- structured contextual fields
- safe telemetry fields
- optional `cause: unknown`

Example:

```ts
export class UserStoreUnavailable extends Error {
	readonly _tag = "UserStoreUnavailable";

	constructor(
		readonly operation: "findActiveByEmail",
		readonly provider: "postgres",
		readonly cause: unknown,
	) {
		super(`User store unavailable during ${operation}`);
	}
}
```

Keep error unions precise at module boundaries:

```ts
Result<User, UserNotFound | UserStoreUnavailable>;
```

Avoid broad `AppError`-style types except near entrypoints, orchestration, logging, and rendering layers.

## Sensitive data, telemetry, and debugging

Prefer end-to-end structured tracing across requests, jobs, workflows, application modules, adapters, and external calls.

Tracing/logging should make failures diagnosable with safe fields:

- domain IDs
- operation names
- dependency/provider names
- state tags
- retry counts
- typed error tags
- safe summaries

Do not put secrets in errors, traces, logs, or snapshots.

Use a `Redacted<T>` wrapper for sensitive values such as tokens, API keys, passwords, raw credentials, and secrets. Prefer Effect's `Redacted.Redacted` in Effect codebases or a local `Redacted<T>` in `prelude.ts`.

Wrap sensitive values at the boundary and unwrap only where the raw value is needed, usually inside an adapter making an external call.

## Parse, don't validate

Boundary code should turn unknown or less-structured input into domain types as early as practical.

Prefer:

```ts
unknown -> HttpBodyDto -> CreateUserInput -> EmailAddress/UserId/etc.
```

not:

```ts
unknown -> z.infer<typeof CreateUserSchema>
```

passed throughout the app.

Use names that preserve meaning:

- `parseX(input): Result<X, ParseXError>` for untrusted or less-structured input
- `makeX(...)` / `createX(...)` for smart constructors from already-typed pieces
- `isX(value): boolean` for true predicates
- `assertX(...)` rarely, mostly at tests/framework boundaries

Avoid `validateX` when the function returns a refined value. It parsed something.

### Schemas

Use schema libraries as boundary parsers, not as ad-hoc validators sprinkled through core logic.

Preference:

- use the repo's established schema library if one exists
- use Effect Schema in Effect codebases
- prefer Standard Schema compatibility for generic helpers
- otherwise prefer Zod 4
- use hand-written smart constructors/parsers for small domain types when clearer

Schema parsing should produce refined/domain types and typed custom errors where practical.

## Branded types and correct construction

Use branded/refined types for meaningful primitives:

- IDs: `UserId`, `OrgId`, `WorkflowId`
- parsed strings: `EmailAddress`, `NonEmptyString`, `Url`
- constrained numbers: `PositiveInt`, `Cents`, `Percentage`
- units: `Milliseconds`, `Bytes`, `UsdCents`

Construct branded values through parsers or smart constructors. Avoid passing raw strings/numbers where a domain type exists.

Avoid optional/null/undefined values in functions that require a value. Push optionality outward. Branch or parse before calling.

Avoid `Partial<T>` as an application/domain input unless partiality is the real domain concept. Prefer explicit input types for each operation.

## State machines and boolean blindness

When an entity has meaningful lifecycle states, model them with tagged unions or equivalent value classes.

Prefer:

```ts
type Invoice =
	| { readonly _tag: "Draft"; readonly id: InvoiceId; readonly lines: NonEmptyArray<LineItem> }
	| { readonly _tag: "Sent"; readonly id: InvoiceId; readonly sentAt: Instant }
	| { readonly _tag: "Paid"; readonly id: InvoiceId; readonly paidAt: Instant };
```

Avoid:

```ts
type Invoice = {
	readonly isSent: boolean;
	readonly isPaid: boolean;
	readonly sentAt?: Date;
	readonly paidAt?: Date;
};
```

Avoid boolean parameters that control behavior:

```ts
createUser(input, true);
```

Prefer named options or domain types:

```ts
createUser(input, { emailVerification: "skip" });
```

Booleans are fine as clear predicate return values:

```ts
isExpired(token): boolean;
hasPermission(user, permission): boolean;
```
