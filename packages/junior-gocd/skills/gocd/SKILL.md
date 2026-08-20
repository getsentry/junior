---
name: gocd
description: Query read-only GoCD pipeline history through the GoCD API. Use when users ask about GoCD pipeline runs, deployment failures, run history, or stage and job outcomes.
---

# GoCD

Use the GoCD plugin tools for live pipeline data.

- `pipelineHistory` returns recent runs for one exact pipeline name.
- `stage` returns one exact stage run: its result, jobs, and failed job names.
- `jobLog` returns the console log for one exact job. It is tailed, de-duplicated, and secret-redacted.

Resolve the exact run first (`pipelineHistory` or a GoCD link), read the failed `stage`, then read the failed `jobLog`. Start with a small tail and expand only if the failure is not in it.

## Auth model

Junior injects host-managed credentials at egress. Tools must not read GoCD tokens directly.

Host configuration:

- `GOCD_URL` or `gocdPlugin({ baseUrl })`
- default path: `GOCD_ACCESS_TOKEN` for bearer auth
- advanced path: host `grantForEgress` / `issueCredential` hooks for extra headers

## Guardrails

- GoCD access is read-only.
- Use an exact pipeline name.
- Do not claim that old console logs are available from pipeline history. Use `jobLog` for console output.
- If `jobLog` reports `available: false`, the log is expired or missing. Say so; do not guess its contents.
- Keep private deploy topology out of generic answers unless the host skill provides it.
- If authentication fails, report whether the host base URL/token is missing or GoCD rejected the request.
