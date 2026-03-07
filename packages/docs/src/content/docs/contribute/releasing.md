---
title: Releasing
description: Package and docs release process.
---

Junior uses lockstep package releases for:

- `@sentry/junior`
- `@sentry/junior-github`
- `@sentry/junior-sentry`

## Package release

1. Open GitHub Actions `Release` workflow.
2. Choose bump (`patch`, `minor`, `major`).
3. Use `force=true` only when intentionally bypassing blockers.

Required configuration:

- Variable: `SENTRY_RELEASE_BOT_CLIENT_ID`
- Secret: `SENTRY_RELEASE_BOT_PRIVATE_KEY`
- npm publish credentials for release runtime

## Docs deployment

Docs are deployed at `https://junior.sentry.dev/` from `packages/docs`.

Recommended preflight:

```bash
pnpm docs:check
```
