import { Brand, Result } from "effect";

import { ActionRejected } from "./errors";

/** A filesystem-safe herdr subagent registry name. */
export type SubagentName = Brand.Branded<string, "SubagentName">;

const SUBAGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const makeSubagentName = Brand.nominal<SubagentName>();

/**
 * Check whether a string is a valid filesystem-safe subagent name.
 *
 * @param input - The string to check.
 * @returns True when the string can be parsed as a {@link SubagentName}.
 */
export const isSubagentName = (input: string): boolean => SUBAGENT_NAME_PATTERN.test(input);

const invalidSubagentNameMessage = (input: string): string =>
	`Invalid subagent name ${input}: use 1-64 characters of letters, digits, dot, underscore, or hyphen.`;

/**
 * Parse a user-supplied subagent name into the filesystem-safe domain type.
 *
 * @param input - The untrusted name to parse.
 * @returns A parsed subagent name, or an action rejection describing the allowed format.
 */
export const parse = (input: string): Result.Result<SubagentName, ActionRejected> => {
	if (!isSubagentName(input)) {
		return Result.fail(new ActionRejected({ message: invalidSubagentNameMessage(input) }));
	}
	return Result.succeed(makeSubagentName(input));
};
