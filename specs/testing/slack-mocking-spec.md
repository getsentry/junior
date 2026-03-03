# Slack HTTP Mocking Spec (MSW + Fixtures)

## Metadata

- Created: 2026-03-02
- Last Edited: 2026-03-03

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.


## Purpose

Define the Slack HTTP contract testing model used by integration tests.
This spec is subordinate to `specs/testing/integration-spec.md`.

## Summary

- Use MSW in Node test runtime as the default interception layer for Slack HTTP.
- Use shared factories/fixtures for Slack API responses and inbound webhook/event payloads.
- Do not stub Slack HTTP directly in test files.
- Integration behavior tests keep runtime wiring real and only substitute the agent boundary.

## Goals

- Deterministic, network-isolated Slack contract tests.
- High-confidence request/response coverage for Slack-facing actions.
- Reusable fixtures and consistent test setup across files.

## Non-goals

- Replacing live Slack transport/integration tests.
- Defining unit-test mocking policy (see `unit-spec.md`).
- Defining eval authoring policy (see `evals-spec.md`).

## Runtime and Compatibility

- Test runtime: Vitest (`environment: "node"`).
- MSW runtime: `msw/node`.
- Slack SDK compatibility:
  - `@slack/web-api` HTTP calls are intercepted by MSW handlers.
  - Native `fetch` calls to Slack endpoints are intercepted by MSW handlers.

## Architecture

### 1) Global MSW lifecycle

- `tests/msw/setup.ts` starts and stops MSW for test/eval runs.
- `tests/msw/server.ts` configures strict unhandled Slack request behavior.
- Setup is wired in `vitest.config.ts` and `vitest.evals.config.ts`.

### 2) Centralized Slack handlers

- `tests/msw/handlers/slack-api.ts`
- `tests/msw/handlers/slack-webhooks.ts`

Handlers support:
- success responses
- Slack API error envelopes
- pagination cursors
- rate limit responses and retry paths

### 3) Shared fixture/factory layer

- `tests/fixtures/slack/factories/api.ts`
- `tests/fixtures/slack/factories/events.ts`
- `tests/fixtures/slack/factories/ids.ts`

Conventions:
- deterministic defaults
- narrow payloads with fields consumed by app/test assertions
- override-friendly builders

## Test Authoring Rules

1. Use MSW handlers for outbound Slack HTTP contract assertions.
2. Use fixture factories for inbound payload construction.
3. Do not directly stub Slack `fetch` endpoints in tests.
4. Do not use broad `vi.mock("@slack/web-api")` in integration tests.
5. In behavior integration tests, do not mock runtime modules; control behavior through the fake-agent seam.

## Required Slack Contract Scenarios

- Success flow for each supported Slack API area.
- Error mapping coverage (`missing_scope`, `not_in_channel`, `invalid_arguments`, `not_found`, etc.).
- Retry coverage for rate limits (`429`, retry-after).
- Pagination coverage where list/history APIs are used.
- Failure on unhandled Slack request paths.

## Acceptance Criteria

- Slack tests run without real Slack network access.
- Shared fixtures/factories are used consistently.
- Contract assertions remain explicit and endpoint-specific.
- Any fallback away from MSW is narrowly scoped and documented in the test file.
