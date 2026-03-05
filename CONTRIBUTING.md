# Contributing

Use this guide for local development in the `junior` monorepo.

## Requirements

- Node.js 20+
- pnpm
- Vercel CLI (`pnpm dlx vercel@latest`)
- Slack app credentials configured in Vercel
- Redis configured in Vercel (`REDIS_URL`)

## Local Setup

1. Install dependencies:

```bash
pnpm install
```

2. Link the repo to Vercel and pull development env vars:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
```

3. Start the app:

```bash
pnpm dev
```

## Development Commands

Run from repo root:

```bash
pnpm test
pnpm evals
pnpm typecheck
pnpm skills:check
```

Build and validate package behavior in the consumer app:

```bash
pnpm build:pkg
pnpm --filter jr-sentry build
```

## File-Scoped Tests

Run a single unit test file:

```bash
pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts
```

Run a single eval file:

```bash
pnpm --filter @sentry/junior exec vitest run -c vitest.evals.config.ts path/to/eval.test.ts
```

## Evals

Use evals for end-to-end behavior testing of Junior's reply pipeline (prompting, tools, and expected outputs). Evals do not test live Slack transport.

See `packages/junior/evals/README.md` and `specs/testing/evals-spec.md` for authoring details.

## Slack Tunnel (Cloudflare)

Install `cloudflared` first (`brew install cloudflared` on macOS).

Quick tunnel with a random hostname:

```bash
cloudflared tunnel --url http://localhost:3000
```

Stable hostname setup:

```bash
cloudflared tunnel login
cloudflared tunnel create junior-dev
cloudflared tunnel route dns junior-dev junior-dev.yourdomain.com
```

Run the stable tunnel:

```bash
cloudflared tunnel run --url http://localhost:3000 junior-dev
```

Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://<tunnel-host>/api/webhooks/slack
```
