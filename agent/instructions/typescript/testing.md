# TypeScript: Testing

Apply the [core standards](../typescript.md). Read this reference when its task branch applies.

## Testing

Prefer confidence-oriented tests:

1. e2e for critical user flows
2. integration tests through real seams
3. focused/property tests for pure domain modules
4. unit tests when they test meaningful behavior, not implementation details

Never use `vi.mock` or `jest.mock` for module mocking. Use real seams:

- constructor-injected interfaces/classes
- Effect services/layers
- local database substitutes such as SQLite
- in-memory adapters when behavior is simple
- fake external adapters when needed

Prefer tests that assert observable input/output behavior:

- returned value/error
- persisted state
- emitted event/message
- rendered response
- sent email record in a fake/local adapter

### Contract, metadata, and generated-artifact tests

Before adding a test, state the observable regression that it prevents. If the test cannot fail without a user-visible contract or boundary behavior changing, do not add it.

For data contracts and localized metadata, test the boundary behavior:

- parsing and rejection of malformed input
- required shape, bounds, identity, and exact coverage
- duplicate, missing, extra, and unknown entries
- version, target, and content-hash checks
- public formatting or transformation behavior
- cross-language fidelity at the artifact/code-generation boundary

Do not test source-controlled copy as if it were program behavior. Do not assert that localized text contains chosen words, and do not repeat exact translations in tests only to freeze wording. Translation correctness and tone require human review. Assert exact text only when the text is itself an explicit public contract.

When testing lookup or formatting behavior, derive the expected localized value from the parsed canonical artifact. Use representative valid and invalid inputs. Do not duplicate the artifact's translated literals in the test.

One artifact-equivalence test at a real generation boundary is sufficient. Do not also test generated constants, trivial lookup forwarding, serialized bytes, and selected field literals. Use artifact drift checks for committed generated files instead of duplicating snapshot assertions in unit tests.

Avoid spy-driven tests like `expect(sendEmail).toHaveBeenCalledWith(...)` unless the interaction itself is the only observable behavior.

For persistence behavior, prefer SQLite/local DB-backed tests over hand-rolled in-memory fakes when SQL/schema/transaction behavior matters.

### Property tests and arbitraries

Use `fast-check` where properties are clearer than examples, especially for:

- parsers/smart constructors
- branded/refined types
- state machines
- serialization roundtrips
- normalization/idempotence
- lawful combinators

Use arbitraries for mock/test data generation. Prefer exporting arbitraries near the domain module they support:

```txt
src/billing/
  invoice-number.ts
  invoice-number.test.ts
  invoice-number.arbitrary.ts
```

Tests should not bypass parsers, smart constructors, or invariants.
