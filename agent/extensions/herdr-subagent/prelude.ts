/**
 * Mark a union switch as exhaustive.
 *
 * @param unexpectedCase - The impossible union member that TypeScript failed to eliminate.
 * @returns Never returns; throws because reaching this helper indicates a programming defect.
 * @throws When a supposedly impossible branch is reached at runtime.
 */
export function casesHandled(unexpectedCase: never): never {
	throw new Error(`Unhandled case: ${String(unexpectedCase)}`);
}
