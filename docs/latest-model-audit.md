# OpenAI latest-model audit

Checked on 2026-09-04 against the current working tree and installed Pi 0.85.0. The linked guide currently describes GPT-6 Astra.

## Scope

The audit covers local settings, model metadata, relevant extensions, agent instructions, and the installed Codex request builder. It does not include private external skills, credentials, or a live API compatibility test. Existing uncommitted changes were included in the review and left unchanged.

The configured provider is `openai-codex`, with the ChatGPT backend. OpenAI's public Responses API documentation is useful guidance, but does not establish that every new field is accepted by that backend.

## Fix status

Local fixes applied after the audit:

- `agent/models.json` now exposes Astra's `low`, `medium`, `high`, `xhigh`, and `max` efforts. Pi clamps `off` and `minimal` to `low`.
- `/effort` uses the active model's supported levels for completion, its picker, and usage. `max` and `maximum` select real `max`. Typed unsupported levels report the effective clamped value. Completion reads the live context so refreshed metadata for the same model is visible without a `model_select` event.
- `agent/AGENTS.md` now covers autonomous follow-through, user-over-skill workflow defaults, skill-block transparency, and stopping verification after appropriate checks pass.
- The local researcher role can write an explicitly authorized research report. It still leaves code and configuration unchanged.
- The local herdr skill continues independently authorized work when orchestration is unavailable. The tool prompt now explicitly encourages useful independent delegation.
- The global Volta package was removed. `~/.local/bin/pi` launches the repository-local installation through `~/.pi/node_modules/.bin/pi`. It was verified from `/tmp` and a fresh login shell.

Matt Pocock skills and their sync patches remain unchanged at the user's request. This includes `/implement` and the research skill. The researcher-role fix resolves the report-writing conflict without changing the research skill.

`configuration_update` remains deferred. It is a separate provider integration, with unresolved Codex backend compatibility and compaction constraints. No experimental API fields were added.

Verification: 76 herdr tests and 6 effort tests passed. The metadata-refresh regression test failed before the fix and passed after it. `npm run typecheck`, focused lint, focused source formatting, and `git diff --check` passed in the parent checkout. The new effort tests live in `tests/effort-extension.test.ts`, outside pi's auto-loaded extension root. Astra's configured effort levels were also checked with Pi's real thinking helpers. No live Astra API probe was run.

## Original findings

The findings and line references below describe the pre-fix audit state.

### 1. Astra's effort metadata is incomplete

**Change recommended.** `agent/models.json:25-35` defines Astra without `thinkingLevelMap`. Pi constructs the model with that missing map, rather than inheriting the built-in map (`node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:48-76`).

An offline call to Pi's actual thinking helpers returned:

```text
supported: off, minimal, low, medium, high
xhigh -> high
max -> high
```

The [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) lists `low`, `medium`, `high`, `xhigh`, and `max`. Add an explicit map that disables `off` and `minimal` and enables supported higher levels, subject to Codex backend support.

`agent/extensions/effort.ts:10-30` also exposes `off` and `minimal`, and treats `max` as an alias for `xhigh`. Its picker should reflect the active model's supported levels. The current `high` default is valid. On the normal Codex path, `off` omits the effort field; it does not send `none`. Thus this audit does not claim that `/effort off` currently causes an HTTP 400. `minimal` is passed through.

Evidence: `node_modules/@earendil-works/pi-ai/dist/models.js:550-584`; `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:361-365,416-424`.

### 2. Effort changes do not preserve the original request-level setting

**Integration opportunity, not an immediate configuration fix.** `/effort` calls `pi.setThinkingLevel`, and the Codex provider puts the selected effort into each request. No `configuration_update` implementation was found in the installed pi-ai JavaScript or the reviewed compaction path.

The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation) recommends history items for effort changes, while keeping request-level effort stable. This can preserve the cached prefix.

Do not add these items without compatibility work. OpenAI limits them to Astra in standard single-agent mode, prohibits adjacent updates, and disallows combining them with automatic compaction, automatic truncation, or `/responses/compact`. Explicit `compaction_trigger` remains supported, but requires a fresh effort update after compaction. Our Codex compactor uses `compaction_trigger`; the direct OpenAI path additionally injects automatic `context_management`.

Evidence: `agent/extensions/effort.ts:97`; `agent/extensions/openai-server-compaction/remote-compaction.ts:928-951`; `agent/extensions/openai-server-compaction/openai.ts:118-129`.

### 3. Global follow-through and skill conflict rules are missing

**Prompt change recommended.** The reviewed global instructions constrain scope, but do not explicitly require completion of authorized reversible work before asking non-blocking questions. They also lack the guide's explicit rule that user requests take precedence over skill guidelines, within higher-priority constraints.

Add a short rule requiring the agent to name and quote the exact skill instruction when it causes a pause or a departure from the requested work. Keep deliberate interactive workflows and explicit capability limits intact.

Evidence: `agent/AGENTS.md`; [initiative guidance](https://developers.openai.com/api/docs/guides/latest-model#initiative-and-follow-through); [instruction-following guidance](https://developers.openai.com/api/docs/guides/latest-model#instruction-following).

### 4. Some skill instructions need narrower conditions

**Targeted audit recommended.** These are concrete examples of the instruction conflicts the guide warns about:

- `agent/skills/implement/SKILL.md:11-15` requires regular checks, the full test suite, a review, and a commit. It is command-only, so these are intentional workflow defaults. However, the full-suite requirement should depend on risk, and an explicit user restriction such as “do not commit” must take precedence.
- `agent/skills/research/SKILL.md` asks the researcher to write a findings file. `agent/agents/researcher.md:4,11` makes that role read-only and gives it no write tool. This audit encountered that exact mismatch: `model-guide-prompts` completed the research but reported blocked on saving its note. The parent saved the combined report. Make the parent own the file, or explicitly use a write-capable role.
- `agent/skills/herdr-subagents/SKILL.md:11` says to stop when herdr is unavailable, while the research skill permits direct research when orchestration is unavailable. Clarify that an orchestration failure need not block independently authorized work.

Delegation is otherwise well specified. `agent/skills/herdr-subagents/SKILL.md:23-34` explicitly encourages useful parallel work and avoids unnecessary agents. The always-loaded tool guideline at `agent/extensions/herdr-subagent/index.ts:328` mentions user-requested orchestration, but does not repeat the proactive rule. This is weaker wording, not an explicit prohibition on proactive delegation.

## Areas already aligned

- **Model and starting effort:** `agent/settings.json:4-6` selects `openai-codex/gpt-6-astra` at `high`. The live shell metadata confirmed the same selection.
- **Responses tool calling:** `agent/models.json:22-23` selects `openai-codex-responses`, not Chat Completions.
- **Sampling parameters:** No forbidden sampling fields are configured for Astra. The normal Codex builder only sends `temperature` if a caller supplies it. Its default `include` requests encrypted reasoning, not output log probabilities. No fast/priority tier is configured in the reviewed settings.
- **Concise output:** `agent/AGENTS.md:33-35` requires short, direct technical language. The Codex request builder defaults to `text.verbosity: "low"` (`openai-codex-responses.js:397`).
- **Proportional tests:** `agent/AGENTS.md:24-31,482-493` requires risk-based test scope and rejects tests that only repeat implementation or static copy.
- **Reasoning and assistant phase:** The normal Responses serializer replays signed reasoning and assistant `phase` (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:132-163`). This is source inspection, not end-to-end proof across all compaction paths.
- **Cache defaults:** The Codex builder uses a stable session cache key and does not send legacy `prompt_cache_retention`. The public [cache guide](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) says `30m` is already the default for GPT-5.6 and later. Missing an explicit `prompt_cache_options.ttl` is therefore not itself a defect. Codex backend semantics were not independently tested.

## Optional new features

The guide introduces native async tools and mid-turn steering. Existing herdr delegation and Pi's queued steering are not proof of support for those API protocols. Their absence is not a migration failure; evaluate them as separate harness work if needed.

## Sources and verification

- [Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model)
- [Astra model capabilities](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Reasoning configuration updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Installed Pi documentation: `docs/models.md`, `docs/settings.md`, and the package README under `node_modules/@earendil-works/pi-coding-agent/`.

The original audit used source inspection and an offline call to `getSupportedThinkingLevels` and `clampThinkingLevel` with the configured Astra definition. The `model-guide-prompts` researcher independently audited prompt alignment. Its panel was inspected and its concrete findings were checked against the files. Its analysis was complete; saving its own note was blocked by its read-only role. At that stage, only this report was added. Subsequent fixes and checks are listed under **Fix status**.
