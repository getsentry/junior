---
name: gocd
description: Read GoCD pipeline and stage results. Use when users ask about GoCD pipeline runs, deployment failures, run history, stages, or jobs.
---

# GoCD

Use the GoCD tools for current pipeline and stage data.

## Rules

- Treat GoCD access as read-only.
- Use `dashboard` to discover exact pipeline names.
- Use `pipelineHistory` to find recent pipeline runs.
- Use `pipelineInstance` for all stages and jobs in one pipeline run.
- Use `pipelineStatus` to check whether a pipeline is paused, locked, or schedulable.
- Use `stage` for one stage run and `jobHistory` for repeated runs of one job.
- Do not claim that any tool includes console output.
- If a request fails, state whether GoCD rejected it or the app lacks a base URL or credentials.
