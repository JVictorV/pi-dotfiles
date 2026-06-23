import { Option, Schema } from "effect";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessageOption = Schema.decodeUnknownOption(ErrorMessage);

/** Typed failure for status-line subprocess and boundary defects. */
export class StatusLineError extends Schema.TaggedErrorClass<StatusLineError>()("StatusLineError", {
	source: Schema.String,
	reason: Schema.String,
}) {}

/** Create a typed status-line failure. */
export const statusLineError = (source: string, reason: string): StatusLineError =>
	StatusLineError.make({ source, reason });

/** Render an unknown caught value as a safe diagnostic reason. */
export const unknownReason = (cause: unknown, fallback: string): string => {
	if (typeof cause === "string" && cause.length > 0) return cause;
	const decoded = decodeErrorMessageOption(cause);
	if (Option.isSome(decoded) && decoded.value.message.length > 0) return decoded.value.message;
	return fallback;
};
