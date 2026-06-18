# GoCD Domain Model and Workflows

## Domain model

- **Pipeline group ("pipedream")**: related pipelines for a deploy target. `getsentry-backend` for example contains `deploy-getsentry-backend-{s4s2,de,us,us2,prod-control,st}`, `rollback-getsentry-backend`, `run-custom-job`, and `post-deploy-migrations`. Other common pipedreams: `getsentry-frontend`, `sentry-saas`, `relay`, `snuba`, `seer`, `taskbroker`, `vroom`.
- **Pipeline**: a deploy target with stages (e.g. `checks`, `migrations`, `deploy-canary`, `deploy-primary`, `pipeline-complete`). `pipeline-complete` marks the run finished — use it to answer "did the deploy actually finish?"
- **Region suffixes** on pipeline names: `-us`, `-de`, `-s4s` / `-s4s2` (single-tenant), `-control` / `-prod-control`, `-customer-N` (per-customer single tenants), `-st`.
- **Region chaining**: pipelines in a pipedream run in a fixed order (`s4s2` → `de` → `us` → `control`/`prod-control` → `st`), each triggered by the previous one via a pipeline-dependency material. A SHA found in `-de` but not `-us` means the rollout is mid-flight, not failed.
- **Rollback pipelines** (`rollback-<service>`): a recent run here means someone rolled back. Rollbacks also pause the deploy pipelines, so paused deploys plus a fresh rollback run usually means incident response is in progress.
- **Stage**: a step within a run; contains jobs. **Job**: a unit of work with a console log.

## Workflows

**"Did my commit ship?"** — `find-deploy <sha> <group>`, e.g. `find-deploy 77f89b7e getsentry-backend`. Returns each run in the window that includes the SHA, with stage statuses. No match means the SHA hasn't entered the pipeline yet or is older than the window (`--count`, default 20 runs/pipeline). A match in earlier regions but not later ones is a mid-flight rollout (see region chaining).

**"What's broken / why did the deploy fail?"** — `failures <group>` returns recent failed runs across the group, each with the failed stage, failed jobs, and last 50 deduped lines of the first failed job's log. For the full log: `job-log ... --full`.

**"What's paused right now?"** — `paused [group]`. Returns each paused pipeline with `paused_by`, `paused_cause`, and `paused_at`. Deploy scripts auto-pause a pipeline when canary fails, so a paused pipeline often means something broke — follow up with `failures <pipeline>`.

**"What's deploying right now?"** — `status <group>` and look for `state: in_flight` (with `--detailed`, `"locked": true` or a stage `"status": "Building"`). A run sitting a few minutes in `deploy-canary` or `soak-time` is a normal 5-minute soak, not a stall.

**"Roll back a deploy"** — not supported here. GoCD web UI or `role-deploy-operator@sentry.io`.
