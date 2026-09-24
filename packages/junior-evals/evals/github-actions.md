# GitHub Actions Eval Setup

Use this when you want PR evals to run in GitHub Actions.

The workflow installs the latest verified `cloudflared` binary and creates a unique account-backed tunnel for each behavioral or integration job.

## Cloudflare Tunnels For CI

Behavioral and integration jobs use `scripts/cloudflare-tunnel.mjs`. Guardian
and Router jobs do not need tunnels. Local evals still use Quick Tunnels.

### Credentials And Dashboard Permissions

Create an **account-owned API token** under **Manage Account → Account API Tokens**.
Name it `junior-ci-github`. Account tokens do not depend on a user's membership.
Use these two policies. These are the dashboard labels confirmed on 2026-09-24:

- **Cloudflare One / Zero Trust → Argo Tunnel (Legacy) → Edit**.
  Scope this policy to the account that owns the DNS zone.
  The API calls this **Cloudflare Tunnel Write**:
  `c07321b023e944ff818fec44d8203567`.
- **DNS & Zones → DNS → Edit** (the first DNS row).
  Scope this policy to the `sentry.cool` zone, not the entire account.
  The API calls this **DNS Write**: `4755a26eedb94da69e1066d98aa820be`.

Do not select **Connectivity Directory**, **Account DNS Settings**, or
**Zone DNS Settings**. These are different permissions. Separate Read permissions
are not required. If the UI also selects Read, it is redundant but valid.
Check the permission IDs in the token's JSON summary before creating it.

The legacy _permission label_ does not mean that CI uses a legacy tunnel.
The script creates remotely managed tunnels with `config_src: "cloudflare"`.
Each connector uses its own tunnel token. Adding a token to an anonymous
`cloudflared tunnel --url` command would not convert it to an account tunnel.

The API token can manage all tunnels in the selected account and all DNS records
in the selected zone. It is not restricted to the `sentry-ci` hostname prefix.
Only trusted CI code may receive it. Fork PRs do not receive repository secrets.
Do not change these workflows to `pull_request_target` to expose secrets to forks.

In **GitHub → getsentry/junior → Settings → Secrets and variables → Actions**, set:

- Repository secret `CLOUDFLARE_API_TOKEN`: the token value. Never log it.
- Repository variable `CLOUDFLARE_ACCOUNT_ID`: the account ID.
- Repository variable `CLOUDFLARE_ZONE_ID`: the 32-character hexadecimal zone ID, not the name `sentry.cool`.
- Repository variable `CLOUDFLARE_TUNNEL_BASE_DOMAIN`: `sentry.cool` (the zone name, not `junior-ci.sentry.cool`).

The zone must belong to the tunnel's Cloudflare account. Do not create a tunnel
or wildcard DNS record by hand. CI uses `sentry-ci-<hash>.sentry.cool`, which
fits the `*.sentry.cool` certificate from Universal SSL. Confirm that certificate
is Active under **SSL/TLS → Edge Certificates**. No advanced certificate is needed.
Do not use a deeper base domain unless its wildcard has separate TLS coverage.
Ensure WAF, Access, and cache rules do not challenge or cache this CI traffic.
The proxy keeps its own auth.

Rotate the API token by creating a replacement with these same permissions,
updating the GitHub secret, and verifying a new job. Let existing jobs finish
cleanup before revoking the old token. To revoke a leaked connector token, delete
that invocation's tunnel. CI never needs a persistent tunnel token or `cert.pem`.

### Script And Lifecycle

From the repository root on a Linux x64 runner:

```bash
node packages/junior-evals/scripts/cloudflare-tunnel.mjs install
node packages/junior-evals/scripts/cloudflare-tunnel.mjs run pnpm --filter @sentry/junior-evals evals:integration --shard=1/2
node packages/junior-evals/scripts/cloudflare-tunnel.mjs cleanup
```

`install` resolves the latest official cloudflared release once, downloads that
release's Linux x64 asset, and verifies its published SHA-256 digest. It fails if
the digest is missing or differs. It logs the version and adds the binary to
`GITHUB_PATH`. The binary does not update itself during the job.

`run` hashes the GitHub run ID, attempt, job, shard, and a fresh UUID. The fresh
UUID also isolates repeated invocations in the same job. It creates one named
tunnel and one proxied CNAME at `sentry-ci-<hash>.sentry.cool`. No pool or locks
are needed across jobs. Each runner supports one invocation at a time on
`127.0.0.1:18787`; different jobs use different runners. The catch-all ingress
rule returns 404. Postgres and Redis are not tunnel targets.

The wrapper starts `cloudflared tunnel run --token-file ...` and the eval command.
The token file has mode 0600 under `RUNNER_TEMP`, outside the repository. The API
token is bound only to the run and cleanup steps. Cloudflare and tunnel variables
are removed from both child environments. Only the connector receives the token
file path; evals receive `JUNIOR_EVAL_EGRESS_URL` and `JUNIOR_EVAL_EGRESS_PORT`.
Neither credential is sent to Vercel Sandboxes.

Global setup waits up to two minutes for public HTTPS to return this proxy's
unique health ID and the real proxy's unauthenticated 401 response. It uses normal
system DNS and certificate checks. A connected tunnel alone is not readiness.
Proxy OIDC authentication and fixture-control bearer authentication are unchanged.

The script logs the DNS record name, target, and proxy flag returned by Cloudflare.
On command or connector failure, it compares system DNS, `1.1.1.1`, and the base
domain's authoritative nameservers before cleanup. These queries are diagnostic
only. They do not replace system DNS, extend readiness, or change the exit code.
Each diagnostic stops waiting after eight seconds. Cancellation skips diagnostics.

The wrapper stops child process groups and removes the DNS record and tunnel on
success, command failure, connector failure, SIGINT, or SIGTERM. An `always()`
workflow step retries cleanup after cancellation or forced process termination.
Cleanup saves exact names before allocation, so a lost create response is recoverable.
It does not retry resource creation. Errors fail the step and retain cleanup state.

A lost runner or SIGKILL can prevent all local cleanup. In that case, use the
Cloudflare dashboard to identify the inactive `sentry-ci-<hash>` tunnel from the
failed job, delete its exact `sentry-ci-<hash>.sentry.cool` CNAME, and delete the
tunnel. Check the job is no longer running first. There is no automatic sweeper
that could delete another active job's tunnel.

Run offline script contract tests with:

```bash
node --test packages/junior-evals/scripts/cloudflare-tunnel.test.mjs
```

Before merge, verify a CI run with the real token and TLS setup. Check public
readiness, concurrent shard isolation, failed-command cleanup, and cancellation
cleanup. Confirm no matching DNS record or tunnel remains after each completed
job. Offline tests cannot prove Cloudflare routing or certificate coverage.

References: [API tunnel setup](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel-api/),
[account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[Universal SSL limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

## Required Secrets

Recommended:

- `VERCEL_OIDC_TOKEN`

`VERCEL_OIDC_TOKEN` is enough for both model calls and Vercel Sandbox access in our eval workflow.

Optional fallback if you do not want to use OIDC:

- `AI_GATEWAY_API_KEY`
- `VERCEL_TOKEN`
- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_ID`

## Sentry Evals Reporting

Add an `evk_...` key from <https://evals.sentry.dev/settings/api-keys> as the
GitHub Actions repository secret `SENTRY_EVALS_API_KEY`. No GitHub Environment
is required. A missing key skips uploads, including on fork pull requests.

Each suite uploads one run after execution. Behavioral and integration combine
all shards. Dataset names are `junior-behavioral`, `junior-integration`,
`junior-guardian`, and `junior-router`. The job summary links to the run.
Existing score gates and artifacts stay in place, including when tests fail.

`scripts/report.mjs` maps Vitest results to scores, errors, transcripts, duration,
available usage metrics, and PR head metadata. It excludes runtime session logs
and intentional skips. File failures and unfinished tests become errors. A crash
before Vitest writes results has no remote report.

Upload errors fail the step. Requests are not retried; rerunning the upload
creates a new run. The script prints the URL before uploading scenarios so a
partial run can be inspected.

From the repository root, with `SENTRY_EVALS_API_KEY` set:

```bash
node packages/junior-evals/scripts/report.mjs router packages/junior-evals/router-results.json
```

Run the offline contract tests with `node --test packages/junior-evals/scripts/report.test.mjs`.

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
- `Guardian evals` runs isolated Guardian snapshots when Guardian eval files/harness changed or the PR has `trigger-evals-guardian` / `trigger-evals`
- `Router evals` runs isolated turn route snapshots when Router eval files/harness changed or the PR has `trigger-evals-router` / `trigger-evals`

Suite labels follow `trigger-evals-[domain]`. Adding a trigger label fires immediately. If the label is already on the PR, future `synchronize` events still run the matching suite(s). Product source under `packages/junior/src/**` does not auto-run evals, except Guardian policy and turn router changes.

Guardian and Router evals only need gateway credentials. Behavioral and integration evals still need gateway plus sandbox access.

## Verification

After adding secrets:

1. Push a commit to the PR, or add the matching `trigger-evals*` label.
2. Open the matching `Behavioral evals`, `Integration evals`, `Guardian evals`, or `Router evals` workflow summary.
3. Confirm its `*/select` job reports `will_run: true` and the required credentials as ready.
4. For behavioral runs, confirm each `behavioral / shard *` job has a shard summary, `behavioral / report` has the combined summary, and the `behavioral / score` Check Run shows the pass-rate gate title.
5. For integration runs, confirm the `integration / shard *` jobs completed. Any case miss fails those jobs hard.
6. For Guardian runs, confirm the `guardian / run` job summary published and the job completed. Exact decision mismatches fail that job hard.
7. For Router runs, confirm the `router / run` job summary published and the job completed. Exact route mismatches fail that job hard.

## Score-Based CI Gate

Only the behavioral suite uses the aggregate floor.

Behavioral shard jobs keep running after individual case failures so every shard can upload its Vitest JSON results and publish its own job summary. Then:

1. `behavioral / report` downloads all behavioral shard result files and publishes one combined `vitest-evals` summary (metric table, score distribution, quality misses)
2. the same step publishes a `behavioral / score` Check Run with `min-pass-rate` (`EVAL_MIN_PASS_RATE`, currently `0.8`)
3. `vitest-evals@0.16.1` attaches that Check Run to the PR head SHA and soft-fails the report step when the check publishes, so the Check Run title owns the pass-rate secondary line on the PR checks list

If Check Run publishing is skipped or fails, the report step still fails on a rejected gate so status is not silently lost.

When the aggregate gate passes, individual case misses are warnings rather than failures. Setup crashes and missing result files still fail the report job hard.

Integration shards fail hard on any case miss and do not use the aggregate floor. Guardian snapshots assert exact `allow` / `ask` / `deny` decisions, publish their own job summary, and fail `guardian / run` on mismatch. Router snapshots assert exact model profile and reasoning level selections, publish their own job summary, and fail `router / run` on mismatch.

If `sandbox_ready` is false, either `VERCEL_OIDC_TOKEN` is missing or the fallback token set is incomplete.

If `gateway_ready` is false while using the fallback path, either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is missing.
