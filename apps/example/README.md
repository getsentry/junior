# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-datadog`, `@sentry/junior-github`, `@sentry/junior-hex`, `@sentry/junior-linear`, `@sentry/junior-notion`, `@sentry/junior-sentry`, `@sentry/junior-vercel`)

## Run

```bash
pnpm install
pnpm dev
```

To load baseline dashboard conversations for visual QA, run:

```bash
JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev
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
- `GITHUB_APP_BOT_NAME` and `GITHUB_APP_BOT_EMAIL` default to the `sentry-junior` GitHub App bot identity for this example app.
- Dashboard auth is enabled by default. `pnpm dev` disables dashboard auth only for local non-Vercel development.
- `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true` overlays read-only sample dashboard conversations for local visual QA.

## Optional plugin env

- `JUNIOR_VERCEL_TOKEN` enables the bundled Vercel plugin's CLI access to deployments and logs.
- Notion does not use `NOTION_TOKEN`; each user connects their own Notion account through MCP OAuth when Junior first calls a Notion tool.

## Wiring

- `plugins.ts` is the single source of truth for installed plugin registrations and runtime hook plugins in this app
- `nitro.config.ts` points `juniorNitro()` at `./plugins` so plugin content is copied into the build output and exposed to runtime through the virtual config module
- `server.ts` imports the same plugin set and passes it to `createApp({ plugins })` so local dev and built bundles load identical runtime plugins
- root `pnpm dev` starts a local heartbeat loop that calls `/api/internal/heartbeat` every minute, matching the production cron pulse used for plugin heartbeats and stale dispatch recovery; it also defaults `JUNIOR_BASE_URL` to the local server when unset so signed internal callbacks can recover dispatched runs
