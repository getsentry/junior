# Junior Example App

This app is the canonical Junior consumer app in this repo. Use it as the main demo and test bed for end-to-end runtime behavior.

It demonstrates:

- one local skill (`/example-local`)
- one plugin-bundled skill (`/example-bundle-help`)
- one bundle-only plugin (`app/plugins/example-bundle/plugin.yaml`) with no credential broker config
- installed plugin packages (`@sentry/junior-agent-browser`, `@sentry/junior-github`, `@sentry/junior-sentry`)

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

## Wiring

- `app/api/webhooks/[platform]/route.ts` handles webhook ingress.
- `app/api/oauth/callback/[provider]/route.ts` handles OAuth callbacks.
- `app/api/queue/callback/route.ts` handles queue callbacks.
- `app/api/health/route.ts` exposes a health endpoint.
- `next.config.ts` enables `withJunior()`.
- `instrumentation.ts` exports Junior instrumentation hooks.
