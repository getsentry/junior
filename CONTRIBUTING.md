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
make
# or: make install
```

This runs `pnpm install` and `dotagents install`.

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
pnpm docs:check
pnpm release:check
```

Build and validate the published package artifacts:

```bash
pnpm build:pkg
```

## Releasing

This repo uses Craft for manual lockstep npm releases of:

- `@sentry/junior`
- `@sentry/junior-agent-browser`
- `@sentry/junior-github`
- `@sentry/junior-notion`
- `@sentry/junior-sentry`

Run `pnpm release:check` before changing release package lists so `.craft.yml`, CI,
the bump script, and the release docs stay aligned.

Trigger releases from GitHub Actions:

1. Open `Actions` -> `Release`.
2. Run workflow with `bump` (`patch`, `minor`, or `major`).
3. Set `force=true` only when intentionally bypassing release blockers.

Required repository/org configuration:

- Variable: `SENTRY_RELEASE_BOT_CLIENT_ID`
- Secret: `SENTRY_RELEASE_BOT_PRIVATE_KEY`
- npm publish credentials available to Craft/action-prepare-release runtime.

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
cloudflared tunnel route dns junior-dev junior-dev.sentry.cool
```

Add the named tunnel token to `.env.local`:

```bash
pnpm cloudflare:token
```

Run `pnpm cloudflare:token` again after `vercel env pull` whenever it rewrites `.env.local`.

Run local dev with the stable tunnel:

```bash
pnpm dev
```

Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://junior-dev.sentry.cool/api/webhooks/slack
```
