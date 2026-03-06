# junior

Junior is a Slack bot runtime for Next.js apps.

Use it to investigate issues, summarize context, and take action from Slack with connected tools.

## Quick Start

Requirements:

- Node.js 20+
- pnpm

Create a new app:

```bash
npx junior init my-bot
cd my-bot
pnpm install
pnpm dev
```

## Use with an Existing App

Install `@sentry/junior` and wire route handlers/config in your app.

See integration details in [packages/junior/README.md](packages/junior/README.md).

## Vercel Setup Overview

Core deployments on Vercel require:

| Service | Required | Why | Setup |
| --- | --- | --- | --- |
| Vercel Queue (`queue/v2beta`) | Yes | Async message processing for Slack thread work | Configure `vercel.json` trigger for `junior-thread-message` |
| Redis (`REDIS_URL`) | Yes | Durable thread state, queue dedup, OAuth state/token storage | Add Redis integration (or external Redis) and set `REDIS_URL` |
| Vercel project env vars | Yes | Runtime credentials/config for Slack + AI + state | Set `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `REDIS_URL`, and model/base URL vars |
| Slack App | Yes (external) | Incoming webhooks/events and bot messaging | Configure request URL to your Vercel deployment |

Full setup and step-by-step commands: [packages/junior/README.md](packages/junior/README.md).

Plugin credentials and provider-specific setup live in plugin docs:

- GitHub plugin: [packages/junior-github/skills/github/README.md](packages/junior-github/skills/github/README.md)
- Sentry plugin: [packages/junior-sentry/README.md](packages/junior-sentry/README.md)

## Packages

| Package | Purpose | Docs |
| --- | --- | --- |
| `@sentry/junior` | Core Slack bot runtime for Next.js | [packages/junior/README.md](packages/junior/README.md) |
| `@sentry/junior-github` | GitHub plugin package for issue workflows | [packages/junior-github/README.md](packages/junior-github/README.md) |
| `@sentry/junior-sentry` | Sentry plugin package for issue workflows | [packages/junior-sentry/README.md](packages/junior-sentry/README.md) |

## Contributing

For local development workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

For plugin authoring and distribution, see [PLUGIN.md](PLUGIN.md).
