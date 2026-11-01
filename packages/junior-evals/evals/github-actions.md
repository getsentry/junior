# GitHub Actions Eval Setup

## Workflows

| Suite       | Workflow                | Jobs                                          | Gate                           |
| ----------- | ----------------------- | --------------------------------------------- | ------------------------------ |
| behavioral  | `evals-behavioral.yml`  | `behavioral / shard *`, `behavioral / report` | `behavioral / score` Check Run |
| integration | `evals-integration.yml` | `integration / shard *`                       | any miss fails                 |
| guardian    | `evals-guardian.yml`    | `guardian / run`                              | any miss fails                 |
| router      | `evals-router.yml`      | `router / run`                                | any miss fails                 |

- A workflow runs when its eval files or harness change, or when the PR has
  `trigger-evals` or `trigger-evals-<suite>`. Other product source under
  `packages/junior/src/**` needs a label, except Guardian and turn router
  source.
- Only behavioral uses the aggregate floor (`EVAL_MIN_PASS_RATE=0.8`). A green
  workflow is not a passing score. Read `behavioral / score`. Missing or empty
  shard results fail hard.
- Each job installs a pinned, checksum-verified `cloudflared` and starts its
  own Quick Tunnel. No Cloudflare secret is needed.

## Secrets

| Secret                                                                      | Use                                       |
| --------------------------------------------------------------------------- | ----------------------------------------- |
| `VERCEL_OIDC_TOKEN`                                                         | Preferred. AI Gateway and Vercel Sandbox. |
| `AI_GATEWAY_API_KEY`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Fallback when OIDC is not used.           |
| `ROACH_TOKEN`                                                               | Recording writes (organization secret).   |
| `SENTRY_EVALS_API_KEY`                                                      | Upload to `evals.sentry.dev`. Optional.   |

- Guardian and router need only gateway credentials. Behavioral and
  integration also need Sandbox access.
- Get `VERCEL_OIDC_TOKEN` with `pnpm dlx vercel link && pnpm dlx vercel env pull`
  and copy it from `.env.local`. `.vercel/project.json` has `orgId`
  (`VERCEL_TEAM_ID`) and `projectId` (`VERCEL_PROJECT_ID`).
- If `sandbox_ready` or `gateway_ready` is false in the `*/select` job, a
  secret in the set is missing.

## Result Upload

- `scripts/report.mjs` uploads one run for each suite, with all shards
  combined. Without `SENTRY_EVALS_API_KEY`, it skips the upload, also on fork
  PRs.
- Upload errors fail the step. It does not retry; a rerun makes a new run.
- Local upload:
  `node packages/junior-evals/scripts/report.mjs router packages/junior-evals/router-results.json`.
- Contract tests: `node --test packages/junior-evals/scripts/report.test.mjs`.
