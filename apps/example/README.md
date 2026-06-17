# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-datadog`, `@sentry/junior-github`, `@sentry/junior-hex`, `@sentry/junior-linear`, `@sentry/junior-notion`, `@sentry/junior-scheduler`, `@sentry/junior-sentry`, `@sentry/junior-vercel`)

## Run

```bash
pnpm install
cp apps/example/.env.example apps/example/.env
docker compose up -d --wait postgres redis
pnpm cli -- upgrade
pnpm dev
```

## Required env

Copy `.env.example`. The local database setting is:

- `DATABASE_URL`

The default value points at the repository's Docker Postgres service on a
nonstandard local port. Root `pnpm cli -- ...` and `pnpm dev` load
`apps/example/.env`, so run `pnpm cli -- upgrade` after starting the local
services so Junior and enabled plugins have their SQL schemas before local chat,
heartbeat, or server paths use them.

## Wiring

- `plugins.ts` is the single source of truth for installed plugin registrations and runtime hook plugins in this app
- `nitro.config.ts` points `juniorNitro()` at `./plugins` so plugin content is copied into the build output and exposed to runtime through the virtual config module
- `server.ts` imports the same plugin set and passes it to `createApp({ plugins })` so local dev and built bundles load identical runtime plugins
- root `pnpm dev` starts a local heartbeat loop that calls `/api/internal/heartbeat` every minute, matching the production cron pulse used for plugin heartbeats and stale dispatch recovery
