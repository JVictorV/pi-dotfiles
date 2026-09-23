# Astra setup audit

## Scope and conclusion

Audit the personal Pi setup against OpenAI's [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
Matt Pocock skill bodies and sync patches are out of scope. The findings below
record the setup before implementation.

## Implementation status

The follow-up change implements priorities 1–4: task-based TypeScript references,
correct Herdr pane identity and current CLI recipes, shorter local skill entry
points with an explicit-only review alias, and proportional worker verification.
Model routing remains unchanged. The recommendations and line counts below are
the original audit evidence, not a description of the updated files.

The main opportunity is more selective instruction loading, not more skills.
Keep project facts, safety boundaries, and deliberate standards. Reduce mandatory reading, duplicated tool references, and unconditional verification steps.
These are recommendations, not measured performance improvements.

## 1. Load TypeScript standards by task

**Evidence:** [Global instructions](../agent/AGENTS.md) require the complete [TypeScript standards](../agent/instructions/typescript.md) before designing, changing, reviewing, or testing TypeScript. The standards contain 663 lines and approximately 3,003 whitespace-separated words.

**Recommendation:** Preserve the standards, but make the entry document a short core plus a task router. Move detailed examples and specialist sections into references for errors/parsing, module design, persistence/workflows, testing, and style/documentation. Require only relevant references.

A small TypeScript change should not require reading saga design, persistence adapters, and property-test examples. Cross-cutting changes can still require several references. The existing [Effect skill's branch chooser](../agent/skills/effect/SKILL.md) is a useful local example.

Do not silently remove personal preferences such as typed failures, brands, or no module mocking. Loading policy and coding policy are separate decisions.

**Article connection:** Replace unconditional document stacks with contextual pointers. Use progressive disclosure.

## 2. Fix stale Herdr guidance before shortening it

**Evidence:** The local [Herdr skill](../agent/skills/herdr/SKILL.md) says “the focused pane is yours.” The [current setup documentation](../README.md#herdr-subagents) explicitly identifies the agent through `HERDR_PANE_ID`, never the focused pane. The skill also uses older ID examples that differ from current tool output.

**Recommendation:** Make `HERDR_PANE_ID` the identity rule. Keep the environment and ownership safeguards. Verify raw CLI recipes against installed help rather than preserving old examples.

Narrow the trigger from “Use when running inside herdr” to requests for raw workspace, tab, pane, or terminal control. Use `herdr-subagents` for Pi delegation. Move the CLI cookbook into a reference file.

**Article connection:** Keep instructions current and make skill triggers specific. This is a correctness issue, not just a context-size issue.

## 3. Reduce local skill and tool duplication

**Evidence:** The [LSP skill](../agent/skills/lsp/SKILL.md) contains 265 lines, including examples for most operations. The LSP tool already advertises its operations, position units, and input schema. The local [review alias](../agent/skills/review/SKILL.md) duplicates automatic routing to the existing review skill.

**Recommendation:** Keep LSP selection guidance, non-obvious limitations, and approval requirements in the root skill. Move examples and troubleshooting into references. Narrow and shorten the description.

Make the local review alias explicit-only with `disable-model-invocation: true`, while preserving command access. Do not change the canonical Pocock review skill.

For [Herdr subagents](../agent/skills/herdr-subagents/SKILL.md), keep one owner for workflow details. Tool guidance should retain essential safety constraints; the skill need not repeat the full parameter reference.

**Pi evidence:** [Installed Pi skill documentation](../node_modules/@earendil-works/pi-coding-agent/docs/skills.md) says names and descriptions enter the system prompt while full bodies load on demand. It supports explicit-only skills. The article's claim about Codex shortening descriptions is not evidence that Pi does the same.

## 4. Make worker verification proportional

**Evidence:** The [worker role](../agent/agents/worker.md) requires project typecheck, lint, and focused tests before every completion. The [global instructions](../agent/AGENTS.md) already scale verification by risk and stop repeated checks after sufficient evidence.

**Recommendation:** Align the worker role with that global policy: run checks relevant to the change; run project-wide checks for shared contracts, dependencies, configuration, or broad changes. Report actual commands, failures, and important checks not run. Do not run TypeScript suites for documentation-only work by default.

Preserve intentional role limits: planners remain read-only, test writers do not edit production code, and diagnosis-only delegation remains diagnosis-only. These are useful boundaries, not accidental early stops.

Document safe test environments in the projects that own them. Do not globally claim that every repository's tests use disposable fixtures or have no production access.

**Article connection:** Avoid redundant verification instructions. Define completion and permitted work without removing safety boundaries.

## 5. Evaluate model routing rather than replacing defaults by assumption

**Evidence:** All eight [role definitions](../agent/agents/) use Astra, with task-specific thinking levels. The main session also uses Astra. The [model matrix](../agent/agents/MODEL-MATRIX.md) already warns that historical comparisons do not establish current performance or cost.

**Recommendation:** Keep current defaults during instruction cleanup. Separately compare Astra and GPT-6 Sol on bounded scouting, research, and implementation tasks. Change a role only after local evidence supports it. Keep the existing Luna prohibition and Terra effort floor.

Use a small reusable task set: a focused lookup, a small bug fix, a cross-module change, a review, and recovery after a context reset. Compare accepted outcomes, missed constraints, elapsed time, input/output/cache usage, and unnecessary tool calls. Repeat samples where model variability matters. Change one setup variable at a time.

**Article connection:** Different models can need different guidance. The task set and measurements are this audit's proposed evaluation method, not a quoted OpenAI prescription.

## Keep as-is initially

- Global permission to complete authorized work and make routine assumptions.
- Narrow change scope, secret handling, and project trust boundaries.
- Stop rules that prevent repeated verification without new evidence.
- Worktree isolation and role-specific edit limits.
- Effect's task-specific reference routing.
- Smart-context checkpoints, original-history retrieval, and the instruction to finish rather than reset when a task is complete.

Do not redesign context management or change its threshold based on this article alone. First measure whether recovery loses decisions or repeats work. Its [current documentation](../agent/extensions/smart-context/README.md) already defines recovery behavior and limitations.

## Suggested order

1. Fix Herdr identity and stale CLI guidance.
2. Add selective loading for TypeScript standards without weakening them.
3. Shorten local LSP/Herdr skill roots and make the review alias explicit-only.
4. Align worker verification with the global completion rule.
5. Evaluate the smaller instruction set, then evaluate model routing separately.
