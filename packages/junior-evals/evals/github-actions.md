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

Four independent workflows run on pull requests:

- `Behavioral evals` runs Slack/agent evals when behavioral eval files/harness changed or the PR has `trigger-evals-behavioral` / `trigger-evals`
- `Integration evals` runs system evals when integration eval files/harness changed or the PR has `trigger-evals-integration` / `trigger-evals`
- `Guardian evals` runs isolated action-review snapshots when Guardian eval files/harness changed, Guardian policy changed, or the PR has `trigger-evals-guardian` / `trigger-evals`
- `Output-router evals` runs isolated prepare-reply cases when those eval files/harness changed, `output-router.ts` changed, or the PR has `trigger-evals-output-router` / `trigger-evals`

Suite labels follow `trigger-evals-[domain]`. Adding a trigger label fires immediately. If the label is already on the PR, future `synchronize` events still run the matching suite(s). Product source under `packages/junior/src/**` does not auto-run evals, except Guardian policy changes in `packages/junior/src/chat/services/guardian-action-policy.ts` and prepare-path changes in `packages/junior/src/chat/services/output-router.ts`.

Guardian and output-router evals only need gateway credentials. Behavioral and integration evals still need gateway plus sandbox access.

## Verification

After adding secrets:

1. Push a commit to the PR, or add the matching `trigger-evals*` label.
2. Open the matching `Behavioral evals`, `Integration evals`, `Guardian evals`, or `Output-router evals` workflow summary.
3. Confirm its `*/select` job reports `will_run: true` and the required credentials as ready.
4. For behavioral runs, confirm each `behavioral / shard *` job has a shard summary, `behavioral / report` has the combined summary, and the `behavioral / score` Check Run shows the pass-rate gate title.
5. For integration runs, confirm the `integration / shard *` jobs completed. Any case miss fails those jobs hard.
6. For Guardian runs, confirm the `guardian / run` job summary published and the job completed. Exact decision mismatches fail that job hard.
7. For output-router runs, confirm the `output-router / run` job summary published and the job completed. Prepare `silent` / `reply` mismatches fail that job hard.

## Score-Based CI Gate

Only the behavioral suite uses the aggregate floor.

Behavioral shard jobs keep running after individual case failures so every shard can upload its Vitest JSON results and publish its own job summary. Then:

1. `behavioral / report` downloads all behavioral shard result files and publishes one combined `vitest-evals` summary (metric table, score distribution, quality misses)
2. the same step publishes a `behavioral / score` Check Run with `min-pass-rate` (`EVAL_MIN_PASS_RATE`, currently `0.8`)
3. `vitest-evals@0.16.1` attaches that Check Run to the PR head SHA and soft-fails the report step when the check publishes, so the Check Run title owns the pass-rate secondary line on the PR checks list

If Check Run publishing is skipped or fails, the report step still fails on a rejected gate so status is not silently lost.

When the aggregate gate passes, individual case misses are warnings rather than failures. Setup crashes and missing result files still fail the report job hard.

Integration shards fail hard on any case miss and do not use the aggregate floor. Guardian snapshots assert exact `allow` / `ask` / `deny` decisions, publish their own job summary, and fail `guardian / run` on mismatch. Output-router cases assert prepare `silent` / `reply` outcomes, publish their own job summary, and fail `output-router / run` on mismatch.

If `sandbox_ready` is false, either `VERCEL_OIDC_TOKEN` is missing or the fallback token set is incomplete.

If `gateway_ready` is false while using the fallback path, either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is missing.
