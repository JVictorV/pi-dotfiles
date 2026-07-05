---
name: debrief
description: Per-file debrief of a change — paths, signatures, intent — so the user scans for weirdness instead of reading the diff.
disable-model-invocation: true
---

# Debrief

Report what just changed so anything weird sticks out. The reader scans for _anomalies_, not correctness — surface everything, sell nothing.

Enumerate files from `git status` / `git diff --stat`, never from memory. Done when every touched file — tests, configs, generated files, deletions included — is accounted for.

For each file:

- **Path** as heading, with added / modified / deleted.
- **Signatures**: each added, changed, or removed function, type, or export — full signature, one line of intent each. Skip bodies unless a body change alters behavior non-obviously.
- **Why**: one sentence tying the file to the task.

Flag loudly at the top, before the per-file list:

- changes nobody asked for (drive-by refactors, formatting churn, renamed things)
- new dependencies, env vars, config, or migrations
- TODOs, stubs, dead code, or anything left unfinished
- deviations from what was requested, with the reason
