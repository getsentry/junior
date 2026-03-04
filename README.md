# junior monorepo

This repository is organized as a workspace:

- `packages/junior`: publishable `junior` package and source
- `packages/jr-sentry`: smoke-test consumer app that uses `junior` via `workspace:*`

Common commands from repo root:

```bash
pnpm install
pnpm build:pkg
pnpm test
pnpm --filter jr-sentry build
```
