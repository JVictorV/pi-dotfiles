/**
 * Auto Session Title Extension
 *
 * On the first user prompt of a fresh session, generates a short, descriptive
 * title from that prompt and sets it as the session name (shown in the
 * `/resume` selector and footer instead of the first message).
 *
 * Behavior:
 * - Runs once per session, on the first `before_agent_start`.
 * - Skips if a name is already set (respects manual `/name`, `--name`, and
 *   resumed/named sessions).
 * - Skips in non-interactive one-shot modes (print/json) where naming is moot.
 * - Fire-and-forget: the title program runs on a detached Effect fiber
 *   (`Effect.runFork`) so the model call never blocks the agent turn. Any
 *   failure or defect is caught (`Effect.catchCause`), leaving the session
 *   unnamed and allowing a retry on the next prompt.
 * - Prefers a cheap, fast model (haiku) for this trivial labeling task and
 *   falls back to the currently active model when none is available/authed.
 */

import { type Api, complete, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Option, Schema } from "effect";

const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_CHARS = 2000;

/**
 * Cheap/fast models to prefer for title generation, in priority order. The
 * active model is used as a last resort (see resolveTitleModel).
 */
const PREFERRED_TITLE_MODELS: ReadonlyArray<{ provider: string; id: string }> = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "openai-codex", id: "gpt-5.4-mini" },
];

type ResolvedModel = {
	model: Model<Api>;
	apiKey: string;
	headers: Record<string, string> | undefined;
};

/** Typed failure for any step of title generation (resolution or completion). */
class TitleError extends Schema.TaggedErrorClass<TitleError>()("TitleError", {
	reason: Schema.String,
}) {}

const titleError = (reason: string): TitleError => TitleError.make({ reason });

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessageOption = Schema.decodeUnknownOption(ErrorMessage);

const unknownReason = (cause: unknown, fallback: string): string => {
	if (typeof cause === "string" && cause.length > 0) return cause;
	const decoded = decodeErrorMessageOption(cause);
	if (Option.isSome(decoded) && decoded.value.message.length > 0) return decoded.value.message;
	return fallback;
};

/**
 * Pick the first preferred cheap model that exists and is authed, falling back
 * to the active model. Fails with TitleError when none are authenticated.
 */
const resolveTitleModel = Effect.fn("resolveTitleModel")(function* (ctx: ExtensionContext) {
	const candidates: Array<Model<Api> | undefined> = [
		...PREFERRED_TITLE_MODELS.map((m) => ctx.modelRegistry.find(m.provider, m.id)),
		ctx.model,
	];

	for (const model of candidates) {
		if (!model) continue;
		const auth = yield* Effect.tryPromise({
			try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
			catch: (cause) => titleError(`auth lookup failed: ${unknownReason(cause, "unknown")}`),
		});
		if (auth?.ok && auth.apiKey) {
			return { model, apiKey: auth.apiKey, headers: auth.headers } satisfies ResolvedModel;
		}
	}

	return yield* Effect.fail(titleError("no authenticated title model available"));
});

/** Resolve a model, call it, and normalize the response into a clean title. */
const generateTitle = Effect.fn("generateTitle")(function* (ctx: ExtensionContext, prompt: string) {
	const resolved = yield* resolveTitleModel(ctx);

	const timestamp = yield* Clock.currentTimeMillis;
	const response = yield* Effect.tryPromise({
		try: () =>
			complete(
				resolved.model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildPrompt(prompt) }],
							timestamp,
						},
					],
				},
				{ apiKey: resolved.apiKey, headers: resolved.headers, reasoningEffort: "low" },
			),
		catch: (cause) => titleError(`completion failed: ${unknownReason(cause, "unknown")}`),
	});

	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ");

	return cleanTitle(text);
});

/** Normalize the model's raw output into a clean one-line title. */
const cleanTitle = (raw: string): string => {
	let title = raw.trim().split("\n")[0]?.trim() ?? "";
	// Strip surrounding quotes/backticks the model sometimes adds.
	title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
	title = title.replace(/\s+/g, " ");
	// Drop trailing punctuation/whitespace.
	title = title.replace(/[.\s]+$/, "");
	if (title.length > MAX_TITLE_LENGTH) {
		title = `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
	}
	return title;
};

const buildPrompt = (prompt: string): string =>
	[
		"Generate a short, descriptive title (3-6 words) for a coding session that begins with the request below.",
		"Respond with ONLY the title — no quotes, no surrounding punctuation, no preamble.",
		"",
		"<request>",
		prompt.slice(0, MAX_PROMPT_CHARS),
		"</request>",
	].join("\n");

export default function (pi: ExtensionAPI) {
	// Per-session guard so we only attempt naming once. Reset on each new session.
	let attempted = false;

	pi.on("session_start", async () => {
		attempted = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (attempted) return;
		// Only meaningful for persistent interactive/RPC sessions.
		if (!ctx.hasUI) return;
		// Respect any existing name (manual /name, --name, or resumed session).
		if (pi.getSessionName()) {
			attempted = true;
			return;
		}

		const prompt = event.prompt?.trim();
		if (!prompt) return;

		// Mark before the async work so concurrent prompts don't double-fire.
		attempted = true;

		// Fire-and-forget: run the title program on a detached fiber so it never
		// blocks the agent turn. On success set the name (re-checking that the
		// user hasn't named it manually while we waited); on any failure or defect
		// leave it unnamed and allow a retry on the next prompt.
		const program = generateTitle(ctx, prompt).pipe(
			Effect.tap((title) =>
				Effect.sync(() => {
					if (title && !pi.getSessionName()) {
						pi.setSessionName(title);
					}
				}),
			),
			Effect.catchCause(() =>
				Effect.sync(() => {
					attempted = false;
				}),
			),
		);

		Effect.runFork(program);
	});
}
