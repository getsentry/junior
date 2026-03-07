---
title: Development
description: Local development workflow for the Junior monorepo.
---

## Prerequisites

- Node.js 20+
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
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
```

## Run

```bash
pnpm dev
```

## Common checks

```bash
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
