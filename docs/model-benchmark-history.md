# Historical subagent model comparison

These figures were retained from the earlier model-selection matrix. This cleanup
did not revalidate them. They do not include GPT-6 Astra and are not routing
instructions. Current selection policy lives in
[`agent/agents/MODEL-MATRIX.md`](../agent/agents/MODEL-MATRIX.md).

The original comparison used DeepSWE's 113-task mini-swe-agent harness. It described
per-token prices as effective rates from local session logs, except for Grok's
published rates. Cost per success was average task cost divided by pass@1.

| Model           | DeepSWE pass@1 | Steps | Cost/task | Cost/success | Input $/M | Cache $/M | Output $/M |
| --------------- | -------------: | ----: | --------: | -----------: | --------: | --------: | ---------: |
| gpt-5.6-terra   |            70% |    76 |      4.95 |         7.07 |      2.50 |      0.25 |      15.00 |
| gpt-5.5 [xhigh] |            67% |    82 |      7.23 |        10.79 |      5.00 |      0.50 |      30.00 |
| gpt-5.6-sol     |            73% |    61 |      8.39 |        11.49 |      5.00 |      0.50 |      30.00 |
| claude-opus-4.8 |            59% |   120 |     13.22 |        22.41 |         — |         — |          — |
| claude-fable-5  |            70% |    88 |     21.63 |        30.90 |         — |         — |          — |
| grok-4.5        |  ~67% estimate |     — |         — |            — |      2.00 |      0.50 |       6.00 |

## Limits of the comparison

- Grok was not measured on DeepSWE. Its estimate came from Artificial Analysis:
  Coding Agent Index 76 and Intelligence Index 54. Those are not same-harness results.
- The original quality measurements used `[max]` effort, not the role defaults.
- Benchmark task cost is not a prediction of local session cost. Long-context
  sessions emphasize cache-read rates; short-context generation emphasizes output rates.
- Effective rates depend on traffic and may differ from provider list prices,
  cache-write prices, or long-context tiers.
- The retained notes did not provide a measurement date or source links for the
  benchmark table. Check current primary sources before making a cost comparison.
