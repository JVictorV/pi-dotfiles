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
 * - Fire-and-forget: the model call never blocks the agent turn. On failure it
 *   leaves the session unnamed and allows a retry on the next prompt.
 * - Prefers a cheap, fast model (haiku) for this trivial labeling task and
 *   falls back to the currently active model when none is available/authed.
 */

import { type Api, complete, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/**
 * Pick the first preferred cheap model that exists and is authed, falling back
 * to the active model. Returns the model plus its resolved credentials.
 */
const resolveTitleModel = async (ctx: ExtensionContext): Promise<ResolvedModel | undefined> => {
	const candidates: Array<Model<Api> | undefined> = [
		...PREFERRED_TITLE_MODELS.map((m) => ctx.modelRegistry.find(m.provider, m.id)),
		ctx.model,
	];

	for (const model of candidates) {
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth?.ok && auth.apiKey) {
			return { model, apiKey: auth.apiKey, headers: auth.headers };
		}
	}
	return undefined;
};

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

		// Fire-and-forget: never block the agent turn on title generation.
		void (async () => {
			try {
				const resolved = await resolveTitleModel(ctx);
				if (!resolved) {
					attempted = false;
					return;
				}

				const response = await complete(
					resolved.model,
					{
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: buildPrompt(prompt) }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: resolved.apiKey, headers: resolved.headers, reasoningEffort: "low" },
				);

				const text = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(" ");

				const title = cleanTitle(text);
				// Re-check: the user may have set a name manually while we waited.
				if (title && !pi.getSessionName()) {
					pi.setSessionName(title);
				}
			} catch {
				// Best effort — leave unnamed and allow a retry next prompt.
				attempted = false;
			}
		})();
	});
}
