# sentry setup

This skill uses per-user OAuth tokens issued via the Authorization Code Grant flow.

## 1) Create Sentry OAuth application

In your personal Sentry account:
1. Go to `User Settings -> Applications -> New Application` at `https://sentry.io/settings/account/api/applications/`.
2. Set the **Redirect URL** to `<base-url>/api/oauth/callback/sentry` (e.g. `https://your-app.vercel.app/api/oauth/callback/sentry`).
3. Save and collect:
   - `SENTRY_CLIENT_ID` (Client ID)
   - `SENTRY_CLIENT_SECRET` (Client Secret)

Scopes are requested at authorization time (not configured in the app). The app requests `event:read org:read project:read`.

## 2) Configure host runtime

Set on the harness host (never in skill files):
- `SENTRY_CLIENT_ID`
- `SENTRY_CLIENT_SECRET`

### Vercel env setup

```bash
vercel env add SENTRY_CLIENT_ID production
vercel env add SENTRY_CLIENT_SECRET production --sensitive
```

If variables already exist, use `vercel env update` instead of `vercel env add`. Repeat for `preview` and `development` as needed. After env changes, redeploy so the new deployment picks up updated values.

### Base URL

The OAuth redirect URI is built from the application's base URL. Resolved in order:
1. `JUNIOR_BASE_URL` env var (explicit override)
2. `VERCEL_PROJECT_PRODUCTION_URL` (auto-set by Vercel)
3. `VERCEL_URL` (deployment-specific fallback)

The base URL must match the redirect URL registered in the Sentry integration above.

### Local development (without OAuth)

Set `SENTRY_AUTH_TOKEN` to a static auth token. The broker falls back to this when no per-user OAuth token exists. Generate one at `https://<org>.sentry.io/settings/auth-tokens/`.

## 3) Runtime behavior

- Each Slack user connects their own Sentry account via `/sentry auth`.
- Tokens are stored per user in Redis (`oauth-token:<userId>:sentry`).
- Credentials are issued lazily when `jr-rpc issue-credential sentry.issues.read` is run.
- If no token exists, the harness auto-starts the OAuth flow, sends an ephemeral authorization link, and auto-resumes the original request after the user authorizes.
- The broker refreshes tokens within 5 minutes of expiry via `grant_type=refresh_token`.
- Sandbox does not receive raw tokens via env; host applies scoped Authorization header transforms for Sentry API calls.
- `SENTRY_AUTH_TOKEN` is injected in the lease env for CLI consumption (`npx @sentry/cli`).

## 4) CLI usage

Run as a regular sandbox `bash` command while this skill is active:

```bash
jr-rpc issue-credential sentry.issues.read
npx @sentry/cli issues list --org ORG --json
```

Optional: set org/project once per channel so they don't need to be repeated:

```bash
jr-rpc config set sentry.org getsentry
jr-rpc config set sentry.project my-project
```

## 5) Quick verification

- `pnpm skills:check`
- `pnpm typecheck`
- Run `/sentry auth` in a Slack thread and complete the OAuth flow.
- Run `/sentry issue list` and confirm issues are returned.

## 6) Production verification (step-by-step)

1. Confirm host env vars are present in prod:
   - `SENTRY_CLIENT_ID`
   - `SENTRY_CLIENT_SECRET`
2. Confirm the redirect URL in the Sentry integration matches `<base-url>/api/oauth/callback/sentry`.
3. Deploy `main` to prod.
4. Run `/sentry auth` — verify ephemeral link appears and OAuth flow completes.
5. Verify callback posts "Your Sentry account is now connected" to the thread.
6. Run `/sentry issue list` — verify issues are returned without re-prompting for auth.
7. Run `/sentry disconnect` — verify tokens are cleared.
8. Run `/sentry issue list` again — verify auto-OAuth kicks in (ephemeral link + auto-resume after auth).
9. Verify raw token values are never printed in output or logs.
10. Check logs for:
    - `jr_rpc_oauth_start`
    - `credential_issue_request`
    - `credential_issue_success`
    - `credential_inject_start`
    - `credential_inject_cleanup`
11. Verify logs contain no token values.
