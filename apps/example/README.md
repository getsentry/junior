# Junior Example App

This app demonstrates a standard Junior setup in `apps/example` with:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config

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

## Wiring

- `app/api/[...path]/route.ts` routes Junior handler endpoints.
- `app/api/queue/callback/route.ts` handles queue callbacks.
- `next.config.ts` enables `withJunior()`.
- `instrumentation.ts` exports Junior instrumentation hooks.
