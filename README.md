# junior Monorepo

`junior` is a Slack bot built with Next.js and Chat SDK.

This repository includes:

- `packages/junior`: the publishable `@sentry/junior` package
- `packages/jr-sentry`: a workspace consumer app used as a package smoke test

## Requirements

- Node.js 20+
- pnpm

## Quick Start

Install dependencies from the repo root:

```bash
make
# or: make install
```

This runs `pnpm install` and `dotagents install`.

Run the local app:

```bash
pnpm dev
```

Run checks:

```bash
pnpm test
pnpm evals
pnpm typecheck
pnpm skills:check
```

Validate the published package against the consumer app:

```bash
pnpm build:pkg
pnpm --filter jr-sentry build
```

## Package Usage

Use `@sentry/junior` in a Next.js app with:

```bash
pnpm add @sentry/junior
pnpm add next react react-dom @sentry/nextjs
```

See package integration details in [packages/junior/README.md](packages/junior/README.md).

## Development Guide

Contributor workflows and local development setup live in [CONTRIBUTING.md](CONTRIBUTING.md).

Plugin authoring and distribution guidance lives in [PLUGIN.md](PLUGIN.md).
