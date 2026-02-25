# junior

Slack bot built with Next.js + Chat SDK.

Junior responds when mentioned in Slack and can continue replying in subscribed threads. It also supports slash-invoked local skills (`/skill-name ...`) and built-in tools (web search/fetch, image generation, Slack canvases/lists).

## Requirements

- Node.js 20+
- pnpm
- Slack app credentials
- AI Gateway API key
- Redis (required for durable thread state)

## Local setup

1. Install dependencies:

```bash
pnpm install
```

2. Create local env:

```bash
cp .env.example .env.local
```

3. Set required env vars in `.env.local`:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AI_GATEWAY_API_KEY`
- `REDIS_URL`

4. Optional env vars:

- `AI_MODEL` and `AI_ROUTER_MODEL`
- `BOT_USERNAME` (default: `junior`)
- `SKILL_DIRS` (additional skill roots; use OS path delimiter)
- `SENTRY_*` and `NEXT_PUBLIC_SENTRY_*`
- `JUNIOR_PROGRESS_FALLBACK_ENABLED`

5. Validate skills:

```bash
pnpm skills:check
```

6. Start the app:

```bash
pnpm dev
```

## Slack app setup

1. Create a Slack app from [`slack-manifest.yml`](slack-manifest.yml).
2. During local development, expose port `3000` with a tunnel (for example `ngrok` or `cloudflared`).
3. Set both Event Subscriptions and Interactivity request URL to:

```text
https://<your-public-host>/api/webhooks/slack
```

4. Install the app to your workspace and invite `@junior` to a channel.

## Endpoints

- `POST /api/webhooks/slack`
- `GET /api/health`

## Skills

- Local skills live in `skills/<skill-name>/SKILL.md`
- Additional skill roots can be configured with `SKILL_DIRS`
- Validate all discovered skills with `pnpm skills:check`

## Commands

```bash
pnpm dev
pnpm test
pnpm typecheck
pnpm skills:check
```

## Notes

- `REDIS_URL` is required; there is no in-memory fallback for state.
- If Sentry env vars are set, server/client instrumentation is enabled automatically.
