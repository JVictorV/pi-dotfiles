# Subagent model-selection matrix

Reference for the herdr orchestrator when choosing a subagent model. This file
has no `name`/`description` frontmatter, so agent discovery skips it — it is a
reference doc, not an agent type.

**Decision rule in one line:** pick the _cheapest_ model whose intelligence clears
the task's difficulty bar — and remember that for long-context work the **cache
rate**, not the headline input/output price, dominates cost.

## The matrix

Intelligence & speed are from **DeepSWE** (113 tasks, mini-swe-agent harness,
contamination-free) for a consistent comparison. Per-token rates are the
**effective rates derived from our own session logs** (xAI docs for Grok).
Cost/success = DeepSWE `avg cost ÷ pass@1` (lower = better value).

| Model             | Intelligence (DeepSWE pass@1) | Speed (steps, lower=faster) | $/task | **$/success** | input $/M | **cache $/M** | output $/M |
| ----------------- | ----------------------------: | --------------------------: | -----: | ------------: | --------: | ------------: | ---------: |
| **gpt-5.6-luna**  |                           67% |                         102 |  $3.03 |     **$4.52** |      1.00 |      **0.10** |       6.00 |
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
  context re-sent every turn): **cache rate dominates.** Ranking:
  **Luna ($0.10) ≫ Terra ($0.25) ≫ Sol = Grok ($0.50).**
  → For our actual (cache-dominated) workload, **Grok is 5× Luna's cache cost.
  Do not route long-context subagents to Grok for cost reasons.**
- **Short-context / output-heavy work** (small prompt, lots of generated code):
  **output rate dominates.** Ranking:
  **Luna = Grok ($6) ≫ Terra ($15) ≫ Sol ($30).**
  → Here Grok is genuinely attractive — Opus-class-ish intelligence at Luna-like
  output price — _if_ context stays small.

## Selection procedure

1. **Classify difficulty.** Hard reasoning / correctness-gating / high-leverage
   (root-cause, review, taste, planning) → top tier. Well-scoped implementation,
   recon, research, tests → lower tier is fine (DeepSWE shows only ~3–6pp drop
   from Sol to Terra/Luna).
2. **Classify token shape.** Long-context/cache-heavy → optimize on **cache
   rate** (Luna/Terra). Short-context/output-heavy → optimize on **output rate**
   (Luna/Grok).
3. **Pick the cheapest model that clears the difficulty bar for that shape** —
   and when the bar is ambiguous, **round up a tier**: under-provisioning costs
   rework loops on the dominant cache-read term, over-provisioning costs cents.
4. **Latency-critical?** Fewer steps = faster wall-clock. Sol (61) and Terra (76)
   finish in the fewest steps; Luna (102) is cheaper but takes more steps.
5. **Escalate on observed failure.** If a terra/luna subagent fails or returns
   low-quality work, re-spawn the retry on the next tier up (luna→terra,
   terra→sol) instead of retrying the same model — failure is the one routing
   signal that is measured, not predicted.

## Recommended defaults by role (already applied in the agent `.md` files)

| Role        | Model     | Thinking | Rationale                                                                        |
| ----------- | --------- | -------- | -------------------------------------------------------------------------------- |
| scout       | **luna**  | low      | recon, cheapest/success, low stakes                                              |
| researcher  | **luna**  | medium   | read + summarize — but keep medium: bad conclusions have no verification harness |
| worker      | **terra** | xhigh    | highest-volume implementation; near-Sol quality at ~59% cost                     |
| test-writer | **terra** | xhigh    | edge-case reasoning + house-rule compliance                                      |
| planner     | **sol**   | xhigh    | high leverage, low volume — bad plans cascade into worker spawns                 |
| debugger    | **sol**   | xhigh    | hard root-cause reasoning                                                        |
| reviewer    | **sol**   | high     | correctness/security safety net; a human reads the output                        |
| critic      | **sol**   | high     | taste judgment; a human reads the output                                         |

**Effort policy:** DeepSWE quality numbers were measured at `[max]` effort, so
implementation/diagnosis roles run `xhigh` to realize the benchmarked quality.
Reasoning is a small cost slice (prior-turn reasoning is dropped from context,
so it does not inflate the dominant cache-read term), and higher effort tends
to finish in fewer turns — which _reduces_ cache-read. `off`/`minimal` remain
banned for subagents. Lowering effort to save cost is a bad trade: it forfeits
measured quality and risks rework loops, the actual dominant cost.

## When to reach for Grok 4.5

- **Good fit:** short-context, output-heavy generation where its $6 output +
  decent intelligence beat Terra/Sol — e.g. drafting lots of boilerplate from a
  small prompt.
- **Bad fit:** our typical long-context repo work — its $0.50 cache rate makes it
  more expensive than Luna/Terra on the dominant term.
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
