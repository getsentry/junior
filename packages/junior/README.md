# @sentry/junior

`@sentry/junior` is a Slack bot package for Next.js apps.

If you are contributing to this monorepo, use the root docs:

- `README.md` for general usage
- `CONTRIBUTING.md` for development workflows

## Install

```bash
pnpm add @sentry/junior
pnpm add next react react-dom @sentry/nextjs
```

## Required App Files

Add these files under `app/`:

```text
app/SOUL.md
app/ABOUT.md
app/skills/
app/plugins/ (optional)
```

## Next.js Integration

`app/api/[...path]/route.js`:

```js
export { GET, POST } from "@sentry/junior/handler";
export const runtime = "nodejs";
```

`app/api/queue/callback/route.js`:

```js
export { POST } from "@sentry/junior/handlers/queue-callback";
export const runtime = "nodejs";
```

`next.config.mjs`:

```js
import { withJunior } from "@sentry/junior/config";
export default withJunior();
```

`instrumentation.js`:

```js
export { register, onRequestError } from "@sentry/junior/instrumentation";
```

If your app does not already include a root layout:

`app/layout.js`:

```js
export { default } from "@sentry/junior/app/layout";
```

## Scaffold a New Bot

```bash
npx junior init my-bot
cd my-bot
pnpm install
pnpm dev
```

## Deploy on Vercel

Use this flow for a production-ready setup.

### 1) Create and link a Vercel project

Dashboard: `Vercel -> Add New... -> Project`, then import your repo.

CLI:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link
```

### 2) Configure required app routes in your Next.js app

Ensure you have these files:

`app/api/[...path]/route.js`:

```js
export { GET, POST } from "@sentry/junior/handler";
export const runtime = "nodejs";
```

`app/api/queue/callback/route.js`:

```js
export { POST } from "@sentry/junior/handlers/queue-callback";
export const runtime = "nodejs";
```

### 3) Configure Vercel Queue

Dashboard: `Project -> Settings -> Functions` (verify queue trigger after deploy).

Add this `vercel.json` trigger:

```json
{
  "functions": {
    "app/api/queue/callback/route.js": {
      "experimentalTriggers": [
        {
          "type": "queue/v2beta",
          "topic": "junior-thread-message"
        }
      ]
    }
  }
}
```

### 4) Configure Redis (`REDIS_URL`)

Dashboard options:

- Add a Redis integration from `Project -> Storage` (for example Upstash Redis), or
- Use any external Redis provider and copy its connection URL.

Then set `REDIS_URL` in Vercel env vars.

### 5) Configure environment variables

Set production env vars first, then repeat for `preview` and `development` as needed.

#### Required

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN` (or `SLACK_BOT_USER_TOKEN`)
- `REDIS_URL`

CLI:

```bash
vercel env add SLACK_SIGNING_SECRET production --sensitive
vercel env add SLACK_BOT_TOKEN production --sensitive
vercel env add REDIS_URL production --sensitive
```

#### Recommended

- `JUNIOR_BOT_NAME` (defaults to `junior`)
- `AI_MODEL` (defaults to `anthropic/claude-sonnet-4.6`)
- `AI_FAST_MODEL` (defaults to `anthropic/claude-haiku-4.5`)

CLI:

```bash
vercel env add JUNIOR_BOT_NAME production
vercel env add AI_MODEL production
vercel env add AI_FAST_MODEL production
```

#### Optional

- `JUNIOR_BASE_URL` (set if your canonical external URL differs from Vercel auto-resolved URLs; used for OAuth callback links)
- `AI_GATEWAY_API_KEY` (optional override; in Vercel runtime, ambient `VERCEL_OIDC_TOKEN` is used automatically for AI gateway auth)

After env changes, redeploy so the new deployment picks up updated values.

### 6) Configure Slack app (external prerequisite)

In Slack app settings:

1. Set request URL(s) to `https://<your-domain>/api/webhooks/slack` for Events and Interactivity.
2. Install the app to your workspace.
3. Copy credentials into Vercel env vars:
   - Bot token -> `SLACK_BOT_TOKEN`
   - Signing secret -> `SLACK_SIGNING_SECRET`

### 7) Deploy and verify

1. Deploy the app to Vercel.
2. Confirm health endpoint responds:
   - `GET https://<your-domain>/api/health`
3. Mention the bot in Slack and confirm a threaded response arrives.
4. Confirm queue processing is active in logs (enqueue + callback processing).
5. Confirm there are no `REDIS_URL is required` runtime errors.

## Plugin Setup

Core setup above is shared. Plugin-specific requirements are documented in each plugin README:

- GitHub: `@sentry/junior-github` -> `packages/junior-github/skills/github/README.md`
- Sentry: `@sentry/junior-sentry` -> `packages/junior-sentry/README.md`
