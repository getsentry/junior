# Design: Slack HTTP Mocking Baseline

## Sources Reviewed

- `specs/slack-http-mocking.md`
- `specs/integration-testing.md`
- `packages/junior/tests/msw/setup.ts`
- `packages/junior/tests/msw/server.ts`
- `packages/junior/tests/msw/handlers/slack-api.ts`
- `packages/junior/tests/msw/handlers/slack-webhooks.ts`
- `packages/junior/tests/fixtures/slack/factories/api.ts`
- `packages/junior/tests/fixtures/slack/factories/events.ts`
- `packages/junior/tests/fixtures/slack/factories/ids.ts`
- representative Slack contract integration tests

External primary sources reviewed:

- MSW Node integration docs for `setupServer`.
- Slack Web API method docs for endpoint-style HTTP contracts.
- Vitest setup file docs for global lifecycle hooks.

## Current Pattern

- MSW starts globally in Vitest setup.
- Test-safe Slack credentials are set before runtime modules import config.
- Unhandled external HTTP fails except explicitly allowed local/model/sandbox/eval fixture hosts.
- Slack API handlers parse JSON, form, and multipart requests.
- Handlers queue method-specific responses, capture requests, provide defaults, and validate adapter-scoped Slack IDs.
- Fixture factories produce deterministic Slack success/error payloads.

## Undefined Behavior

- Some non-Slack provider HTTP mocks live in the same MSW setup; this spec covers Slack-specific behavior only.
- Handler support is added method-by-method; unsupported Slack methods fail unless added.
- Request ordering is available through captured calls, but tests should assert ordering only when it is part of the contract.

## Verification Strategy

- Slack contract integration tests verify request shapes and handler behavior.
- MSW setup is exercised by all package tests/evals.
- `slack-http-mocking` remains subordinate to `integration-testing`.
