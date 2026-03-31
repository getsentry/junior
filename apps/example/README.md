# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-github`, `@sentry/junior-notion`, `@sentry/junior-sentry`)

## Run

```bash
pnpm install
pnpm --filter @sentry/junior-example dev
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

- `api/index.ts` creates a Hono app via `createApp()` and exports it with `handle()` from `hono/vercel`
- installed plugin packages are discovered automatically; there is no per-plugin runtime registration in the app entrypoint
- `vercel.json` configures function settings, includes `app/**/*`, and includes packaged plugin content with a single `node_modules/@sentry/junior-*` glob
