# Subagent model-selection matrix

Reference for the herdr orchestrator when choosing a subagent model. This file
has no `name`/`description` frontmatter, so agent discovery skips it — it is a
reference doc, not an agent type.

**Decision rule in one line:** use Sol by default; Terra is eligible only with
`high` or `xhigh` thinking when its cost advantage fits the task. Never recommend
Luna for subagents. For long-context work, remember that the **cache rate**, not
the headline input/output price, dominates cost.

## The matrix

Intelligence & speed are from **DeepSWE** (113 tasks, mini-swe-agent harness,
contamination-free) for a consistent comparison. Per-token rates are the
**effective rates derived from our own session logs** (xAI docs for Grok).
Cost/success = DeepSWE `avg cost ÷ pass@1` (lower = better value).

| Model             | Intelligence (DeepSWE pass@1) | Speed (steps, lower=faster) | $/task | **$/success** | input $/M | **cache $/M** | output $/M |
| ----------------- | ----------------------------: | --------------------------: | -----: | ------------: | --------: | ------------: | ---------: |
| **gpt-5.6-terra** |                           70% |                          76 |  $4.95 |     **$7.07** |      2.50 |      **0.25** |      15.00 |
| gpt-5.5 [xhigh]   |                           67% |                          82 |  $7.23 |        $10.79 |      5.00 |          0.50 |      30.00 |
| **gpt-5.6-sol**   |                       **73%** |                      **61** |  $8.39 |        $11.49 |      5.00 |          0.50 |      30.00 |
| claude-opus-4.8   |                           59% |                         120 | $13.22 |        $22.41 |         — |             — |          — |
| claude-fable-5    |                           70% |                          88 | $21.63 |        $30.90 |         — |             — |          — |
| **grok-4.5**      |            ~67% ⚠️ (see note) |              n/a on DeepSWE |    n/a |           n/a |      2.00 |      **0.50** |       6.00 |

⚠️ **Grok 4.5 is not on DeepSWE.** Its ~67% here is a cross-walk from Artificial
Analysis (Coding Agent Index 76 ≈ GPT-5.5-in-Codex; Intelligence Index 54, 4th
overall). Treat as approximate until we have a same-harness number.

## The two cost regimes (this is the important part)

Cost is not one number — which model is cheapest flips depending on the task's
token shape:

- **Long-context / cache-heavy work** (most of our subagent turns — big repo
  context re-sent every turn): **cache rate dominates.** Terra ($0.25/M) is
  cheaper than Sol and Grok ($0.50/M), but Terra remains restricted to `high`
  or `xhigh` thinking. Do not trade away effort to chase its token rate.
- **Short-context / output-heavy work** (small prompt, lots of generated code):
  **output rate dominates.** Grok ($6/M) is cheaper than Terra ($15/M) and Sol
  ($30/M), so it can be attractive for explicitly selected generation tasks if
  context stays small.

## Selection procedure

1. **Classify difficulty.** Hard reasoning / correctness-gating / high-leverage
   work (root-cause, review, taste, planning) routes to Sol. Terra is for
   well-scoped implementation and tests where the output has a verification
   harness.
2. **Choose effort before model.** `low` or `medium` routes to Sol. Terra is
   eligible only with `high` or `xhigh`; the extension rejects lower or missing
   effort for Terra.
3. **Classify token shape.** Long-context/cache-heavy work emphasizes cache
   rate; short-context/output-heavy work emphasizes output rate.
4. **Pick the cheapest permitted model that clears the difficulty bar** — and
   when the bar is ambiguous, choose Sol: under-provisioning costs rework loops,
   while over-provisioning costs cents.
5. **Latency-critical?** Fewer steps = faster wall-clock. Sol (61) and Terra (76)
   finish in the fewest measured steps.
6. **Escalate on observed failure.** If a Terra subagent fails or returns
   low-quality work, re-spawn the retry on Sol instead of retrying Terra.

## Recommended defaults by role (already applied in the agent `.md` files)

| Role        | Model     | Thinking | Rationale                                                        |
| ----------- | --------- | -------- | ---------------------------------------------------------------- |
| scout       | **sol**   | low      | quick recon still benefits from the reliable default             |
| researcher  | **sol**   | medium   | conclusions lack an automatic verification harness               |
| worker      | **terra** | xhigh    | well-scoped implementation with tests and caller review          |
| test-writer | **terra** | xhigh    | edge-case reasoning plus an executable verification harness      |
| planner     | **sol**   | xhigh    | high leverage, low volume — bad plans cascade into worker spawns |
| debugger    | **sol**   | xhigh    | hard root-cause reasoning                                        |
| reviewer    | **sol**   | high     | correctness/security safety net; a human reads the output        |
| critic      | **sol**   | high     | taste judgment; a human reads the output                         |

**Effort policy:** Terra has a hard floor of `high`; use `xhigh` for its default
implementation and test-writing roles. The extension rejects Terra with missing,
`low`, or `medium` thinking. DeepSWE quality numbers were measured at `[max]`
effort, reasoning is a small cost slice, and higher effort tends to finish in
fewer turns — reducing cache-read. `off`/`minimal` remain banned for every
subagent. Lowering effort to save cost forfeits measured quality and risks rework
loops, the actual dominant cost.

## When to reach for Grok 4.5

- **Good fit:** short-context, output-heavy generation where its $6 output and
  decent intelligence beat Terra/Sol — e.g. drafting lots of boilerplate from a
  small prompt.
- **Bad fit:** our typical long-context repo work — its $0.50 cache rate is twice
  Terra's on the dominant term.
- **Enablement:** the extension no longer restricts subagent models to the
  `openai-codex` family — any model resolvable in pi's registry can be spawned.
  Grok just needs a pi login; once available, pass its canonical reference
  (e.g. `<provider>/grok-4.5`) as `model` on spawn.

## Caveats

- DeepSWE `$/task` is a **benchmark harness** figure — do **not** map it onto our
  bill (our cost is dominated by cache-read from long sessions, which the
  benchmark does not model). Trust the **relative** intelligence/speed ordering
  and the **per-token rates**, not the absolute $/task.
- Cross-benchmark numbers (Grok via Artificial Analysis) are not directly
  comparable to DeepSWE pass@1. Flagged inline.
- Effective per-token rates are derived from our logs on our traffic; provider
  list pricing may differ for cache write / very large context tiers.
