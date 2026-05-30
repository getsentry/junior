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

```bash
pnpm install
```

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

This starts the example app on `http://localhost:3000` by default. It also rebuilds and watches the workspace packages that the example app consumes, so dashboard and runtime package edits are reflected without manually rebuilding first.

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
