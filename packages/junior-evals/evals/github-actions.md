# GitHub Actions Eval Setup

Use this when you want PR evals to run in GitHub Actions.

The workflow installs a pinned `cloudflared` binary and starts a unique Quick Tunnel for each eval job. No Cloudflare account secret or fixed public hostname is required.

## Required Secrets

Recommended:

- `VERCEL_OIDC_TOKEN`

`VERCEL_OIDC_TOKEN` is enough for both model calls and Vercel Sandbox access in our eval workflow.

Optional fallback if you do not want to use OIDC:

- `AI_GATEWAY_API_KEY`
- `VERCEL_TOKEN`
- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_ID`

## How To Get Them

### `VERCEL_OIDC_TOKEN`

From the repo root:

```bash
pnpm dlx vercel link
pnpm dlx vercel env pull
```

Then copy `VERCEL_OIDC_TOKEN` from `.env.local` into the GitHub repository secret `VERCEL_OIDC_TOKEN`.

This is the preferred path. It does not require `AI_GATEWAY_API_KEY`.

### Optional: token-based fallback

### `VERCEL_TOKEN`

1. Open Vercel account settings.
2. Create an access token.
3. Scope it to the team that owns the `junior` project.
4. Add it to GitHub as `VERCEL_TOKEN`.

### `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`

From the repo root:

```bash
pnpm dlx vercel link
cat .vercel/project.json
```

Use:

- `orgId` as `VERCEL_TEAM_ID`
- `projectId` as `VERCEL_PROJECT_ID`

Local link metadata lives in `.vercel/project.json`.

### `AI_GATEWAY_API_KEY`

Only needed for the token-based fallback above. Create an AI Gateway key in the Vercel dashboard and add it as `AI_GATEWAY_API_KEY`.

## Triggering Evals On A PR

The `Evals` workflow can start two independent suites on pull requests:

- end-to-end Slack/agent evals when e2e-related files changed or the PR has `trigger-evals`
- isolated Guardian snapshots when Guardian-related files changed, the PR has `trigger-evals-guardian`, or the PR has `trigger-evals`

Adding `trigger-evals` or `trigger-evals-guardian` fires immediately. If the label is already on the PR, future `synchronize` events still run the matching suite(s).

Guardian evals only need gateway credentials. End-to-end evals still need gateway plus sandbox access.

## Verification

After adding secrets:

1. Push a commit to the PR, or add the `trigger-evals` / `trigger-evals-guardian` label.
2. Open the `Evals` workflow summary.
3. Confirm the gate reports:
   - `gateway_ready: true`
   - `sandbox_ready: true` for end-to-end runs
   - `will_run: true` and/or `will_run_guardian: true`
4. For end-to-end runs, confirm each `evals / suite *` job has a shard summary, `evals / report` has the combined summary, and `evals / score` shows the pass-rate gate in its job name.
5. For Guardian runs, confirm the `evals / guardian` job summary published and the job completed. Exact decision mismatches fail that job hard.

## Score-Based CI Gate

End-to-end shard jobs keep running after individual case failures so every shard can upload its Vitest JSON results and publish its own job summary. Then:

1. `evals / report` downloads all shard result files and publishes one combined `vitest-evals` summary (metric table, score distribution, quality misses)
2. `evals / report` stays green even when the floor is missed (`continue-on-error`) and exports gate outputs
3. `evals / score · <gate title>` is a real Evals workflow job that owns green/red for `EVAL_MIN_PASS_RATE` (currently `0.8`) and carries the score in the job name shown on the PR checks list

We intentionally do **not** publish a detached Checks API run for the score. Those attach under random `github-actions` suites (sometimes CodeQL) and can target the PR merge commit instead of the head SHA.

When the aggregate gate passes, individual case misses are warnings rather than failures. Setup crashes and missing result files still fail the report job hard.

Guardian snapshots are not part of that aggregate floor. They assert exact `allow` / `ask` / `deny` decisions, publish their own job summary, and fail `evals / guardian` on mismatch.

If `sandbox_ready` is false, either `VERCEL_OIDC_TOKEN` is missing or the fallback token set is incomplete.

If `gateway_ready` is false while using the fallback path, either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is missing.
