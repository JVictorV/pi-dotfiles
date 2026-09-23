# Operator environment

My dev machine runs Linux. Manual tests against the game run on my Windows
PC — reach it with `ssh maven`. When a task needs running Windows binaries
(loader, injector, game-side verification), do it over SSH on `maven`; don't
assume local execution is possible.

# Task execution

- Treat action requests such as “can you fix…” as instructions to do the work. Complete the authorized work, including appropriate verification, rather than stopping at a plan or partial result.
- Make reasonable assumptions for routine gaps. Before asking a question, complete the authorized work that does not depend on its answer. Ask when the answer would materially change the outcome or authorization is missing for a destructive or external action.
- Treat skill steps as workflow defaults. Explicit user instructions take precedence over those defaults, subject to higher-priority instructions and tool permissions. Preserve deliberate interactive workflows, delegated edit limits, and stops caused by unavailable required project instructions.
- If a skill causes a pause, unfinished work, or a departure from the user's request, link the exact `SKILL.md`, quote the relevant instruction, and explain its effect. Distinguish the instruction from your interpretation.
- Keep secrets out of source control, tool output, errors, logs, traces, and snapshots.

# Coding and verification

When rules conflict, prioritize correctness, safety, and debuggability, then the
project's established architecture and conventions. Improve the code in scope
without a broad migration unless the user requests one. Document meaningful
trade-offs with comments or ADRs.

- Prefer existing patterns, frameworks, helpers, and abstractions over inventing new ones.
- Keep changes narrowly scoped to the requested behavior. Exclude unrelated refactors, renames, metadata churn, speculative features, and incidental cleanup.
- Add an abstraction only when it removes real complexity, eliminates meaningful duplication, or matches an established local pattern. Hypothetical reuse or extensibility is not enough.
- Scale tests with risk and blast radius. Broaden them for shared behavior, cross-module contracts, regressions, or critical user workflows.
- After appropriate checks pass, repeat or broaden them only for new changes, failures, or unresolved concerns. Then complete the task.
- Test observable behavior, not static declarations, implementation details, removed behavior, trivial forwarding, or invariants guaranteed by types and boundary parsers.
- When requirements are unclear, implement the minimum behavior needed for correctness. Add policy, edge cases, configuration, or fallback behavior only for a concrete requirement.

# TypeScript work

For TypeScript work, read the [core standards](instructions/typescript.md), then
only the reference sections that match the task. The core routes design, parsing,
error, testing, and style concerns. Also read the project's local instructions and
inspect its existing conventions.

# Communication

Use ASD-STE100 Simplified Technical English for user communication and documentation.
Use short, direct sentences, active voice, consistent terminology, and one idea per
sentence. Avoid idioms, ambiguous wording, and unnecessary detail. Preserve exact
code identifiers, API names, error text, and quotations when accuracy requires them.
