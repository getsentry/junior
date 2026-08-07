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

The `Evals` workflow can start three independent suites on pull requests:

- behavioral Slack/agent evals when behavioral-related files changed or the PR has `trigger-evals-behavioral` / `trigger-evals`
- integration system evals when integration-related files changed or the PR has `trigger-evals-integration` / `trigger-evals`
- isolated Guardian snapshots when Guardian-related files changed or the PR has `trigger-evals-guardian` / `trigger-evals`

Suite labels follow `trigger-evals-[domain]`. Adding a trigger label fires immediately. If the label is already on the PR, future `synchronize` events still run the matching suite(s).

Guardian evals only need gateway credentials. Behavioral and integration evals still need gateway plus sandbox access.

## Verification

After adding secrets:

1. Push a commit to the PR, or add the matching `trigger-evals*` label.
2. Open the `Evals` workflow summary.
3. Confirm the gate reports:
   - `gateway_ready: true`
   - `sandbox_ready: true` for behavioral/integration runs
   - `will_run_behavioral`, `will_run_integration`, and/or `will_run_guardian` as expected
4. For behavioral runs, confirm the `evals / report` job published the combined suite summary and pass-rate gate.
5. For integration runs, confirm the `evals / integration *` jobs completed. Any case miss fails those jobs hard.
6. For Guardian runs, confirm the `evals / guardian` job completed. Exact decision mismatches fail that job hard.

## Score-Based CI Gate

Only the behavioral suite uses the aggregate floor.

Behavioral shard jobs keep running after individual case failures so every shard can upload its Vitest JSON results. The final `evals / report` job:

1. Downloads all behavioral shard result files
2. Publishes one combined `vitest-evals` job summary with pass counts and average score
3. Posts an `eval score / behavioral` Check Run whose PR checks secondary line is the pass rate / floor text
4. Leaves the workflow job green for quality misses so GitHub does not also show a canned "Failing after Xs" job row

The Check Run fails when the aggregate pass rate is below `EVAL_MIN_PASS_RATE` (currently `0.8`). Setup crashes and missing result files still fail the report job hard. The upstream `vitest-evals` Check Run stays disabled because v0.15.0 still concludes it from any case failure.

Integration shards fail hard on any case miss and do not use the aggregate floor. Guardian snapshots assert exact `allow` / `ask` / `deny` decisions and fail `evals / guardian` on mismatch.

If `sandbox_ready` is false, either `VERCEL_OIDC_TOKEN` is missing or the fallback token set is incomplete.

If `gateway_ready` is false while using the fallback path, either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is missing.
