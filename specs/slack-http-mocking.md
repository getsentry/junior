# Slack HTTP Mocking Spec

## Metadata

- Created: 2026-03-02
- Last Edited: 2026-07-02

## Purpose

Document the Slack MSW and fixture harness used by integration tests.

## Runtime

- Vitest runs Slack HTTP tests in Node.
- `packages/junior/tests/msw/setup.ts` starts/stops MSW.
- `packages/junior/tests/msw/server.ts` owns strict unhandled Slack request
  behavior.
- Slack SDK and native `fetch` calls to Slack endpoints are intercepted by MSW.

## Fixtures And Handlers

- Slack handlers: `packages/junior/tests/msw/handlers/slack-api.ts`
- Slack webhook handlers: `packages/junior/tests/msw/handlers/slack-webhooks.ts`
- API factories: `packages/junior/tests/fixtures/slack/factories/api.ts`
- Event factories: `packages/junior/tests/fixtures/slack/factories/events.ts`
- ID factories: `packages/junior/tests/fixtures/slack/factories/ids.ts`

Handlers cover success responses, Slack error envelopes, pagination, rate
limits, and contract validation for Slack-only request shapes.

## Test Rules

1. Use MSW handlers for Slack HTTP assertions.
2. Use fixture factories for inbound Slack payloads.
3. Do not stub Slack `fetch` endpoints directly in tests.
4. Do not use broad `vi.mock("@slack/web-api")` in integration tests.
5. In behavior integration tests, keep runtime wiring real and control behavior
   through the fake-agent seam.

## Acceptance

- Tests must not access real Slack network endpoints.
- Contract assertions should be endpoint-specific.
- Any fallback away from MSW must be narrow and documented in the test file.
