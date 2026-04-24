---
title: Development
description: Local development workflow for the Junior monorepo.
type: tutorial
prerequisites: []
related:
  - /contribute/testing/
  - /contribute/releasing/
  - /start-here/quickstart/
---

## Prerequisites

- Node.js 24
- pnpm
- Vercel CLI
- Slack app credentials
- Redis configured for development

## Setup

Install workspace dependencies first:

```bash
pnpm install --frozen-lockfile
```

If you only need to run tests or inspect the repo and want to skip package lifecycle scripts during install, use:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

That is enough to make repo-local CLIs like `vitest` available. If you later need generated build artifacts or prepare hooks, rerun `pnpm install --frozen-lockfile` without `--ignore-scripts`.

Then pull local Vercel env:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes
pnpm dlx vercel@latest env pull .env --environment=development
```

If your team account requires an explicit Vercel scope, add `--scope <team-slug>` to the `link` and `env pull` commands.

## Run

```bash
pnpm dev
```

This starts the example app on `http://localhost:3000` by default.

## Common checks

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm skills:check
pnpm docs:check
```

## Slack tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

Set Event Subscriptions and Interactivity URL to:

```text
https://<tunnel-host>/api/webhooks/slack
```

## Next step

Run focused checks from [Testing](/contribute/testing/), then verify behavior in [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/).
