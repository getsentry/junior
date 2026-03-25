# GitHub Actions Eval Setup

Use this when you want PR evals to run in GitHub Actions.

Current repo state: this is not intended to be configured right now. Keep this as future setup guidance unless we explicitly decide to turn PR evals on with real GitHub secrets.

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

Current local link metadata lives in [.vercel/project.json](/home/dcramer/src/junior/.vercel/project.json).

### `AI_GATEWAY_API_KEY`

Only needed for the token-based fallback above. Create an AI Gateway key in the Vercel dashboard and add it as `AI_GATEWAY_API_KEY`.

## Triggering Evals On A PR

The `Evals` workflow runs on pull requests when either:

- eval-related files changed
- the PR has the `trigger-evals` label

Adding the `trigger-evals` label fires the workflow immediately. If the label is already on the PR, future `synchronize` events still run evals.

## Verification

After adding secrets:

1. Push a commit to the PR, or add the `trigger-evals` label.
2. Open the `Evals` workflow summary.
3. Confirm the gate reports:
   - `gateway_ready: true`
   - `sandbox_ready: true`
   - `will_run: true`

If `sandbox_ready` is false, either `VERCEL_OIDC_TOKEN` is missing or the fallback token set is incomplete.

If `gateway_ready` is false while using the fallback path, either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is missing.
