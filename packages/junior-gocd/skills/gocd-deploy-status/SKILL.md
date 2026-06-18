---
name: gocd-deploy-status
description: Read-only access to Sentry's GoCD deploy pipelines. Query pipeline and group status, fetch deploy/console logs, view run history, list paused pipelines, and find which runs include a commit SHA. Use when asked about deployments, deploy status, pipeline status, deploy logs, build failures, what's deploying, why a deploy failed, did my commit ship, gocd, pipeline, canary, stage failed, or paused pipelines. Do not use it to trigger, pause, unpause, or roll back deploys — this skill is read-only.
allowed-tools: bash
---

# GoCD Deploy Status (Read-Only)

The drill-in tool for GoCD deploy questions. It reads pipeline status, history, and logs; it cannot trigger, pause, or roll back anything (that goes through the GoCD web UI or `role-deploy-operator@sentry.io`). The runtime authenticates GoCD traffic for you — do not set or print any token or auth env vars.

## Commands

Run from the skill working directory: `python3 scripts/gocd.py <cmd>` (or use the absolute path under `working_directory`).

| Command                                                              | What it does                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pipelines`                                                          | List all pipeline groups and their pipelines                                                                            |
| `status <name> [--detailed]`                                         | Status of a pipeline or group; group summary is one dashboard call, `--detailed` fans out for full materials/all-stages |
| `history <pipeline> [--count N]`                                     | Recent runs (default 5) with materials and stages                                                                       |
| `stage <pipeline> <pctr> <stage> <sctr>`                             | Stage instance detail with job timings                                                                                  |
| `job-log <pipeline> <pctr> <stage> <sctr> <job> [--tail N] [--full]` | Console log; smart-deduped, last 200 lines by default                                                                   |
| `find-deploy <sha> <pipeline-or-group> [--count N]`                  | Find runs that include a commit SHA                                                                                     |
| `failures <pipeline-or-group> [--count N]`                           | Recent failed runs with failed-job log excerpts                                                                         |
| `paused [group]`                                                     | Currently-paused pipelines with who/why/when                                                                            |

`status <group>` and `paused` are a single dashboard API call; `status --detailed`, `find-deploy`, and `failures` fan out per pipeline. The `status` group summary returns one of `paused`, `in_flight` (a run is locked or a stage is building), or `idle` per pipeline.

## References

| Need                                                                   | Read                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Domain model (pipedreams, region chain, rollback semantics), workflows | [references/domain-model.md](references/domain-model.md) |
| GoCD API shapes, field traps, archived logs                            | [references/api-surface.md](references/api-surface.md)   |

## Guardrails

- Read-only. Never attempt to trigger, pause, unpause, cancel, or roll back; if the user wants that, point them to the GoCD web UI or `role-deploy-operator@sentry.io`.
- Do not set, read, or print auth env vars (`GOCD_ACCESS_TOKEN`, IAP tokens, GCP credentials). The runtime injects credentials at the network boundary.
- Prefer the group summary (`status <group>`) before fanning out; reach for `--detailed` only when you need materials or every stage.
- A run "stuck" for a few minutes in `deploy-canary` or `soak-time` is normal — those stages have intentional 5-minute soak windows.
