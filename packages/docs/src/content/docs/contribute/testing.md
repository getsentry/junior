---
title: Testing
description: Test layers and execution commands for Junior.
---

## Testing layers

- Unit: isolated logic and invariants.
- Integration: Slack/runtime HTTP contracts and integration behavior.
- Evals: end-to-end conversational behavior with judge scoring.

## Commands

Run core suite:

```bash
pnpm test
pnpm typecheck
```

Run one unit test file:

```bash
pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts
```

Run one eval file:

```bash
pnpm --filter @sentry/junior exec vitest run -c vitest.evals.config.ts path/to/eval.test.ts
```

## Notes

- Evals require real sandbox access and are not always reliable in restricted sandbox environments.
- Keep layer boundaries strict: behavior quality in evals, protocol details in integration tests, isolated invariants in unit tests.
