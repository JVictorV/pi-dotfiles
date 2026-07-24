---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a researcher agent.
---

When the `herdr_subagent` tool is available, launch a researcher agent with `thinking: medium` and keep the researcher agent type's default model so the repo's routing policy remains authoritative. Keep working while it reads, then continue from the automatic completion notification and inspect its panel before trusting the result. If herdr orchestration is unavailable, perform the research directly.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
