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

## Packages

| Package | Purpose | Docs |
| --- | --- | --- |
| `@sentry/junior` | Core Slack bot runtime for Next.js | [packages/junior/README.md](packages/junior/README.md) |
| `@sentry/junior-github` | GitHub plugin package for issue workflows | [packages/junior-github/README.md](packages/junior-github/README.md) |
| `@sentry/junior-sentry` | Sentry plugin package for issue workflows | [packages/junior-sentry/README.md](packages/junior-sentry/README.md) |

## Contributing

For local development workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

For plugin authoring and distribution, see [PLUGIN.md](PLUGIN.md).
