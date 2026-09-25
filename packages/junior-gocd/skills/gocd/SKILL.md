---
name: gocd
description: Read GoCD pipeline and stage results. Use when users ask about GoCD pipeline runs, deployment failures, run history, stages, or jobs.
---

# GoCD

Use the GoCD tools for current pipeline and stage data.

## Rules

- Treat GoCD access as read-only.
- Use the configured pipeline when the user does not name one.
- Use `pipelines` to find pipeline names and `pipelineHistory` for recent runs.
- Use the narrower run, stage, status, or job tool when the request needs it.
