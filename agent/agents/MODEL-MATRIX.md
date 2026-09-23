# Subagent model selection

## Sources of truth

- Role `.md` frontmatter owns each role's model, thinking level, and tool defaults.
  Use `herdr_subagent action=agent-types` to read the effective definitions.
- Plain-spawn fallback selection belongs to the subagent engine, not Pi's main
  session model. Explicit `model`, `thinking`, and `tools` parameters override role defaults.
- The [herdr-subagents skill](../skills/herdr-subagents/SKILL.md) owns orchestration workflow.

## Override policy

1. Use the role default unless the task has a concrete reason for an override.
2. Choose effort for the task. Use `low` for quick reconnaissance, `medium` for
   ordinary research, implementation, and tests, `high` for review and planning,
   and `xhigh` for difficult debugging. Only these four subagent levels are permitted.
3. Never select Luna. Terra is eligible only with `high` or `xhigh` thinking for
   well-scoped implementation or tests with an executable verification procedure.
   The engine enforces Terra's effort floor.
4. If Terra fails or produces poor work, retry with the role's default model rather
   than repeating the Terra run. Prefer the role default when difficulty is unclear.
5. Other authenticated providers may be selected explicitly. Use a canonical
   `provider/model-id` reference available in Pi's model registry.
6. Check current model capabilities and prices before a cost-based override.
   Account for cache-heavy versus output-heavy workloads. Historical benchmark
   results do not establish current performance or predict local session cost.

For historical analysis only, see the
[archived model comparison](../../docs/model-benchmark-history.md).
