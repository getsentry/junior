---
title: Testing
description: Test layers and execution commands for Junior.
type: reference
summary: Choose the right Junior test layer and run targeted unit or eval files with canonical commands.
prerequisites:
  - /contribute/development/
related:
  - /contribute/releasing/
  - /start-here/verify-and-troubleshoot/
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

## Next step

After adding or changing tests, run the deploy checks in [Releasing](/contribute/releasing/) and validate runtime behavior via [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/).
