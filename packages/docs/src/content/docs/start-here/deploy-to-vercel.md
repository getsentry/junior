---
title: Deploy to Vercel
description: Deploy a scaffolded Junior app to Vercel and verify production Slack delivery.
type: tutorial
summary: Configure Vercel build, env vars, Slack URLs, and production verification for Junior.
prerequisites:
  - /start-here/quickstart/
  - /start-here/slack-app-setup/
related:
  - /reference/config-and-env/
  - /operate/observability/
  - /start-here/verify-and-troubleshoot/
---

The scaffolded app is already shaped for Vercel. Deployment mainly means linking the project, setting env vars, enabling snapshot warmup support, and pointing Slack at the production URL.

## Link the project

Authenticate and link the local app to a Vercel project:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link
```

If your account requires a team scope, pass the same `--scope <team-slug>` value to Vercel commands.

## Configure build command

The scaffolded `package.json` includes the production build script:

```json title="package.json"
{
  "scripts": {
    "check": "junior check",
    "dev": "vite dev",
    "build": "junior snapshot create && vite build"
  }
}
```

Keep the Vercel build command as `pnpm build`. `junior snapshot create` prepares sandbox runtime dependencies declared by enabled plugins before request handling starts.

## Configure production environment

Set the core runtime variables in Vercel:

| Variable                                    | Required    | Purpose                                                                        |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `SLACK_SIGNING_SECRET`                      | Yes         | Verifies Slack requests.                                                       |
| `SLACK_BOT_TOKEN` or `SLACK_BOT_USER_TOKEN` | Yes         | Posts replies and calls Slack APIs.                                            |
| `REDIS_URL`                                 | Yes         | Queue and runtime state storage.                                               |
| `JUNIOR_SECRET`                             | Yes         | Signs internal callbacks and sandbox requester context.                        |
| `JUNIOR_BASE_URL`                           | Conditional | Canonical URL for OAuth and callback URLs when Vercel URL envs are not enough. |
| `JUNIOR_STATE_KEY_PREFIX`                   | No          | Redis key namespace for this deployment when sharing one Redis database.       |
| `AI_GATEWAY_API_KEY`                        | Optional    | AI Gateway auth when your setup requires it.                                   |

Use one stable `JUNIOR_SECRET` per deployment:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Plugin pages list provider-specific env vars such as GitHub App settings or Datadog keys.

## Enable snapshot warmup credentials

If enabled plugins need sandbox runtime dependencies, `junior snapshot create` runs during build. In Vercel, enable OIDC so `VERCEL_OIDC_TOKEN` is available during the build.

Snapshot warmup also needs `REDIS_URL` during build because the snapshot registry is Redis-backed.

## Point Slack at production

Update these Slack URLs to your production domain:

```text
https://<your-domain>/api/webhooks/slack
```

Apply the URL to:

- Event Subscriptions
- Interactivity
- `/jr` slash command

Reinstall the Slack app if scopes changed.

## Verify production

Run these checks after deployment:

1. `GET https://<your-domain>/health` returns `status: "ok"`.
2. A Slack mention produces a thread reply in the expected workspace.
3. App Home opens without an error.
4. Queue callback and turn logs show successful processing.
5. One enabled plugin workflow succeeds end to end.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then monitor production with [Observability](/operate/observability/).
