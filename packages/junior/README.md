# junior

Slack bot built with Next.js + Chat SDK.

Junior responds when mentioned in Slack and can continue replying in subscribed threads. It also supports slash-invoked local skills (`/skill-name ...`) and built-in tools (web search/fetch, image generation, Slack canvases/lists).

## Project layout

Junior uses one standard Next.js model:

```text
app/data/
  SOUL.md           # Personality
app/skills/         # Skill definitions
app/plugins/        # Provider plugins (optional)
```

## Requirements

- Node.js 20+
- pnpm
- Vercel CLI
- Slack app credentials already configured in Vercel
- Redis configured in Vercel (`REDIS_URL`)

## Local setup

1. Install dependencies.

```bash
pnpm install
```

2. Link this repo to the Sentry Vercel project and pull dev env.

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
```

3. Start the app.

```bash
pnpm dev
```

This runs the app with files loaded from `app/data/`, `app/skills/`, and `app/plugins/` in `packages/junior/`.

## Deploying your own bot

Junior is available as an npm package and integrates as standard Next.js wrappers.

### Workspace consumer smoke app

This repo includes a local consumer app at `packages/jr-sentry/` to validate package behavior before deployment.

From repo root:

```bash
pnpm install
pnpm --filter jr-sentry build
```

If you change package code and want to refresh generated `dist/` before validating:

```bash
pnpm build:pkg
pnpm --filter jr-sentry build
```

### Install into an existing Next.js app

1. Install dependencies:

```bash
pnpm add junior
pnpm add next react react-dom @sentry/nextjs
```

2. Add bot files under `app/`:

```text
app/data/SOUL.md
app/skills/
app/plugins/ (optional)
```

3. Use normal Next.js scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

4. Add wrapper files:

`app/api/[...path]/route.js`:

```js
export { GET, POST } from "junior/handler";
export const runtime = "nodejs";
```

`app/api/queue/callback/route.js`:

```js
export { POST } from "junior/handlers/queue-callback";
export const runtime = "nodejs";
```

`next.config.mjs`:

```js
import { withJunior } from "junior/config";
export default withJunior();
```

`instrumentation.js`:

```js
export { register, onRequestError } from "junior/instrumentation";
```

If your app doesn't already have a root app layout, add:

`app/layout.js`:

```js
export { default } from "junior/app/layout";
```

### Scaffold a new bot project

```bash
npx junior init my-bot
cd my-bot
pnpm install
pnpm dev
```

This scaffolds a project with `app/data/SOUL.md`, plus empty `app/skills/` and `app/plugins/` directories.

### Vercel deployment

1. Push your project to GitHub.
2. Import the repo in Vercel.
3. Set **Build Command** to `pnpm build` and **Framework** to "Next.js".
4. Add environment variables: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `REDIS_URL`, and optionally `NEXT_PUBLIC_SENTRY_DSN`, `JUNIOR_BOT_NAME`, `AI_MODEL`, and `AI_FAST_MODEL`.
5. Add a `vercel.json` trigger for queue callbacks:

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

## Slack tunnel (Cloudflare)

Install `cloudflared` if you don't have it (`brew install cloudflared` on macOS).

### Quick (random hostname each time)

```bash
cloudflared tunnel --url http://localhost:3000
```

### Stable hostname (one-time setup)

Requires a free Cloudflare account and a domain managed through Cloudflare DNS.

```bash
cloudflared tunnel login
cloudflared tunnel create junior-dev
cloudflared tunnel route dns junior-dev junior-dev.yourdomain.com
```

Then each time you develop:

```bash
cloudflared tunnel run --url http://localhost:3000 junior-dev
```

### Configuring Slack

Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://<tunnel-host>/api/webhooks/slack
```

With a stable hostname you only need to do this once. Invite `@junior` to a channel and mention it.

## Evals

Use evals for end-to-end behavior testing of Junior's reply pipeline (prompting, tools, and expected outputs) with LLM-judged numeric scoring.

Evals intentionally exclude live Slack integration concerns (Slack transport, app permissions, and webhook delivery).

Authoring guidance lives in `evals/README.md` and `../../specs/testing/evals-spec.md`.

```bash
pnpm evals
```

## Test env isolation

Vitest loads `.env`, `.env.local`, `.env.test`, then `.env.test.local` so test-specific values override development/prod values.

Slack credentials are intentionally replaced with test values for tests/evals to prevent accidental use of real Slack tokens.
