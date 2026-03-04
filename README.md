# junior

Slack bot built with Next.js + Chat SDK.

Junior responds when mentioned in Slack and can continue replying in subscribed threads. It also supports slash-invoked local skills (`/skill-name ...`) and built-in tools (web search/fetch, image generation, Slack canvases/lists).

## Home directory

Junior loads its personality, skills, and bot config from an external **home directory** specified by `--home` (or `JUNIOR_HOME` env var). The included `jr-sentry/` directory is Sentry's home:

```
jr-sentry/
  config.toml       # Bot identity + model config
  SOUL.md           # Personality
  skills/           # Skill definitions
    brief/
    github/
    jr-rpc/
    sum/
```

`config.toml` example:

```toml
[bot]
name = "junior"

[ai]
model = "anthropic/claude-sonnet-4.6"
fast_model = "anthropic/claude-haiku-4-5"
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

This runs with `jr-sentry` as the home directory. To use a different home:

```bash
JUNIOR_HOME=./my-home pnpm dev
```

## Production

```bash
node bin/junior.mjs --home=./jr-sentry --port 3000
```

## Deploying your own bot

Junior is available as an npm package and integrates as standard Next.js wrappers.

### Install into an existing Next.js app

1. Install dependencies:

```bash
pnpm add junior
pnpm add next react react-dom @sentry/nextjs
```

2. Add bot home files in your project root:

```text
config.toml
SOUL.md
skills/
```

3. Set `JUNIOR_HOME` in your scripts:

```json
{
  "scripts": {
    "dev": "JUNIOR_HOME=. next dev",
    "build": "JUNIOR_HOME=. next build",
    "start": "JUNIOR_HOME=. next start"
  }
}
```

4. Add wrapper files:

`app/api/[...path]/route.ts`:

```ts
export { GET, POST } from "junior/handler";
export const runtime = "nodejs";
```

`next.config.ts`:

```ts
import { withJunior } from "junior/config";

export default withJunior();
```

`instrumentation.ts`:

```ts
export { register, onRequestError } from "junior/instrumentation";
```

If your app doesn't already have a root app layout, add:

`app/layout.tsx`:

```tsx
export { default } from "junior/app/layout";
```

### Scaffold a new bot project

```bash
npx junior init my-bot
cd my-bot
pnpm install
pnpm dev
```

This scaffolds a project with `config.toml`, `SOUL.md`, and an empty `skills/` directory. Edit those files to customize your bot's personality and capabilities.

### Vercel deployment

1. Push your project to GitHub.
2. Import the repo in Vercel.
3. Set **Build Command** to `pnpm build` and **Framework** to "Next.js".
4. Add environment variables: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `REDIS_URL`, and optionally `NEXT_PUBLIC_SENTRY_DSN`.

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

Authoring guidance lives in `evals/README.md` and `specs/testing/evals-spec.md`.

```bash
pnpm evals
```

## Test env isolation

Vitest loads `.env`, `.env.local`, `.env.test`, then `.env.test.local` so test-specific values override development/prod values.

Slack credentials are intentionally replaced with test values for tests/evals to prevent accidental use of real Slack tokens.
