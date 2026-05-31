# Design: Integration Testing Baseline

## Sources Reviewed

- `specs/integration-testing.md`
- `specs/testing.md`
- `specs/slack-http-mocking.md`
- `packages/junior/vitest.config.ts`
- `packages/junior/tests/integration/**`
- `packages/junior/tests/fixtures/chat-runtime.ts`
- `packages/junior/tests/fixtures/slack-harness.ts`
- `packages/junior/tests/msw/**`
- `packages/junior/scripts/check-slack-test-boundary.mjs`

External primary sources reviewed:

- Vitest config/setup docs for node test environment and setup files.
- MSW Node docs for central HTTP interception.
- Slack Web API docs as prior art for payload contract testing through HTTP fixtures.

## Current Pattern

Integration tests split into:

- scenario behavior tests, usually named `*-behavior.test.ts`, which assert user-visible runtime outcomes;
- transport-contract tests, often named `*-contract.test.ts`, which assert Slack API request/response details;
- cross-module integration tests for auth, MCP, scheduler, dispatch, sandbox, and package discovery.

The preferred substitution is a deterministic fake agent or reply executor at the composition boundary. Slack HTTP uses MSW.

## Undefined Behavior

- Some tests outside `tests/integration/slack/**` may still use patterns that the boundary checker does not inspect.
- The line between behavior and transport-contract assertions is still review-driven.
- Some older integration tests may assert internal details because they predate the current split.

## Verification Strategy

- Focused command: `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`.
- Full package test runs boundary checks and all Vitest tests.
- Slack HTTP details are refined by `slack-http-mocking`.
