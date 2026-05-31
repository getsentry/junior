# Design: Testing Taxonomy Baseline

## Sources Reviewed

- `specs/testing.md`
- `specs/unit-testing.md`
- `specs/integration-testing.md`
- `specs/eval-testing.md`
- `specs/slack-http-mocking.md`
- `packages/junior/vitest.config.ts`
- `packages/junior/package.json`
- `packages/junior/scripts/check-slack-test-boundary.mjs`
- `packages/junior/tests/unit/**`
- `packages/junior/tests/integration/**`
- `packages/junior/tests/msw/**`
- `packages/junior/tests/fixtures/slack/**`
- `packages/junior-evals/package.json`
- `packages/junior-evals/README.md`
- `packages/junior-evals/vitest.config.ts`
- `packages/junior-evals/vitest.evals.config.ts`
- `packages/junior-evals/evals/**`
- `policies/evals.md`

External primary sources reviewed:

- Vitest config docs for include/exclude, node environment, projects, setup files, and mocking patterns.
- MSW Node docs for centralized request interception in Node tests.
- Vercel AI Gateway docs for provider/model-backed eval execution context.

## Prior-Art Interpretation

The taxonomy should mirror established test pyramid practice but adjust for agent behavior:

- Unit tests are cheap and local but should not fake a whole product workflow.
- Integration tests validate deterministic product/runtime behavior through real wiring and external-contract mocks.
- Evals are the integration-style layer for model-dependent behavior because the model interpretation is part of the contract.

For Slackbot behavior, low-level transport contracts and conversational behavior are different risks. Slack HTTP payload assertions belong in integration tests; natural-language turn handling belongs in evals.

## Current Execution Shape

- `@sentry/junior` tests run with Vitest in node environment, include `tests/**/*.test.ts`, and use `tests/msw/setup.ts`.
- `pnpm --filter @sentry/junior run test:slack-boundary` runs before the package test suite.
- Boundary enforcement rejects Slack/MSW internals in eval files and `vi.mock` in designated Slack behavior integration tests.
- `@sentry/junior-evals` has separate unit harness tests and eval execution scripts.
- Evals run with memory state and replay mode by default and use real model/gateway behavior through the eval harness.

## Undefined Behavior

- Some existing tests are historically named or scoped by implementation area rather than capability contract.
- The boundary checker covers selected patterns, not every policy violation.
- The test taxonomy says integration is default for runtime behavior, but existing legacy unit tests still cover some broader runtime seams.
- Evals may be named by file history rather than behavior requirement; migration mapping is a separate task.
- Exact commands for "full verification" depend on the changed surface and can be expensive.

## Verification Strategy

- This spec is policy/contract. It is verified by strict OpenSpec validation plus existing test boundary scripts.
- Narrower layer specs should own concrete fixture and test authoring details.
- The eval migration map should audit existing eval names/scopes against capability requirements.
