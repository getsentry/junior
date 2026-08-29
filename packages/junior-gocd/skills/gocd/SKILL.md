---
name: gocd
description: Read GoCD pipeline and stage results. Use when users ask about GoCD pipeline runs, deployment failures, run history, stages, or jobs.
---

# GoCD

Use the GoCD tools for current pipeline and stage data.

## Rules

- Treat GoCD access as read-only.
- Use the exact pipeline name.
- Use `pipelineHistory` to find recent pipeline runs.
- Use `stage` when the user needs the jobs or failed job names for one stage run.
- Do not claim that pipeline history includes console logs.
- If a request fails, state whether GoCD rejected it or the app lacks a base URL or credentials.
