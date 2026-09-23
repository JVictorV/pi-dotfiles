# TypeScript: Style and documentation

Apply the [core standards](../typescript.md). Read this reference when its task branch applies.

## TypeScript style and safety

Use strict TypeScript settings where practical:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`

Prefer immutable values:

```ts
type CreateUserInput = {
	readonly email: EmailAddress;
	readonly roles: ReadonlyArray<Role>;
};
```

Mutation is acceptable inside localized imperative shell code, performance-sensitive internals, builders, or adapters when hidden behind a precise interface.

### Casts, `any`, and non-null assertions

Avoid:

- `any`
- non-null assertions (`!`)
- casts with `as Type`

`as const` is fine.

Rare exceptions are allowed for highly generic helpers, branding internals, interop boundaries, or combinators where TypeScript cannot express the invariant.

Any non-`as const` cast requires a Rust-like safety comment:

```ts
// SAFETY: TypeScript cannot express the brand. parseEmailAddress checked the normalized string before branding. Callers cannot construct EmailAddress except through this parser.
return normalized as EmailAddress;
```

Rare `any` also requires a targeted oxlint ignore and justification:

```ts
// oxlint-disable-next-line no-explicit-any -- SAFETY: This helper preserves arbitrary function parameters; TypeScript cannot express this variadic constraint without any.
type Fn = (...args: any[]) => unknown;
```

Do not use `!`. Branch, parse, or refine instead.

## Imports, exports, and files

Prefer direct imports from the file that owns the abstraction. Avoid barrel files / `index.ts` re-export layers by default.

For domain modules, namespace imports often preserve the module shape:

```ts
import * as EmailAddress from "./email-address";

EmailAddress.parse(input);
```

Use named imports for classes, prelude helpers, and focused shared helpers:

```ts
import { casesHandled } from "./prelude";
import { PasswordReset } from "./password-reset";
```

Use `import type` / `export type` for type-only imports and exports.

Export only what callers should use. Keep internal helpers unexported unless intentionally shared. Do not export internals just for tests.

Avoid TypeScript `namespace` unless there is a compelling interop reason.

Avoid vague files:

```txt
utils.ts
helpers.ts
common.ts
misc.ts
```

Use precise names:

```txt
email-address.ts
billing-period.ts
string-case.ts
array.ts
prelude.ts
```

`prelude.ts` is allowed for tiny ubiquitous generic helpers/types such as:

- `casesHandled`
- `shouldNeverHappen`
- `notYetImplemented`
- `Redacted`
- common `Result` helpers
- broad type utilities

Do not put domain/application policy in `prelude.ts`.

No arbitrary file-size limits. Prefer cohesion and discoverability over small files for their own sake. Split when a file has multiple unrelated reasons to change or callers must understand unrelated concepts.

## Comments and JSDoc

Comments should explain invariants, trade-offs, non-obvious domain rules, and safety justifications. Avoid comments that narrate obvious code.

Every exported function, class, method, constant, and usually exported type should have JSDoc.

Use standard JSDoc syntax:

```ts
/**
 * Parse an email address from untrusted input.
 *
 * @param input - The untrusted string to parse.
 * @returns A parsed email address, or `InvalidEmailAddress` when the input is invalid.
 */
export function parse(input: string): Result<EmailAddress, InvalidEmailAddress>;
```

For generics:

```ts
/**
 * Map the success value of a result.
 *
 * @template T - The original success type.
 * @template U - The mapped success type.
 * @template E - The error type.
 * @param result - The result to map.
 * @param fn - The function applied to the success value.
 * @returns A result with the mapped success value, or the original error.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
```

Use `@throws` only for unrecoverable defects, framework-required behavior, or temporary `notYetImplemented` paths. Do not document expected typed errors as throws.

For complex exported object types, document fields when helpful:

```ts
/** Input required to create a user. */
export type CreateUserInput = {
	/** The actor creating the user. */
	readonly actor: AdminUser;

	/** The parsed email address for the new user. */
	readonly email: EmailAddress;
};
```
