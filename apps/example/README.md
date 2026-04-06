# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-github`, `@sentry/junior-linear`, `@sentry/junior-notion`, `@sentry/junior-sentry`)

## Run

```bash
pnpm install
pnpm dev
```

## Required env

Copy `.env.example` and set:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `REDIS_URL`
- `AI_MODEL` (optional)
- `AI_FAST_MODEL` (optional)
- `NOTION_TOKEN` (optional, enables the bundled Notion plugin)

## Wiring

- `nitro.config.ts` declares `pluginPackages` in `juniorNitro()` — this both copies plugin content at build time and makes the list available to `createApp()` at runtime via a virtual module
- `server.ts` creates the Hono app via `createApp()` — plugin packages are resolved automatically from the build config
