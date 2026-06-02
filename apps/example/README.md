# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-github`, `@sentry/junior-hex`, `@sentry/junior-linear`, `@sentry/junior-notion`, `@sentry/junior-sentry`, `@sentry/junior-vercel`)

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
- `AI_VISION_MODEL` (optional, enables image-understanding; unset disables vision features)
- `AI_WEB_SEARCH_MODEL` (optional, overrides the `webSearch` tool model; defaults to a search-tuned model)
- `JUNIOR_SECRET` (required outside `pnpm dev`; the local wrapper supplies a dev-only secret when unset)
- `JUNIOR_SCHEDULER_SECRET` or `CRON_SECRET` (optional for `pnpm dev`; the local wrapper supplies a dev-only heartbeat secret when both are unset)
- Dashboard auth is enabled by default. `pnpm dev` disables dashboard auth only for local non-Vercel development.

## Optional plugin env

- `JUNIOR_VERCEL_TOKEN` enables the bundled Vercel plugin's CLI access to deployments and logs.
- Notion does not use `NOTION_TOKEN`; each user connects their own Notion account through MCP OAuth when Junior first calls a Notion tool.

## Wiring

- `plugin-packages.ts` is the single source of truth for installed plugin packages in this app
- `nitro.config.ts` passes that list to `juniorNitro()` so plugin content is copied into the build output
- `server.ts` passes the same list to `createApp()` so local dev does not depend on Nitro's virtual config path for plugin discovery
- root `pnpm dev` starts a local heartbeat loop that calls `/api/internal/heartbeat` every minute, matching the production cron pulse used for trusted plugin heartbeats and stale dispatch recovery; it also defaults `JUNIOR_BASE_URL` to the local server when unset so signed internal callbacks can recover dispatched runs
