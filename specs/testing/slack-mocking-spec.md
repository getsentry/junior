# Slack Mocking Spec (MSW + Fixtures)

## Summary
- Standardize Slack-related tests on one mocking architecture.
- Use MSW in Node test runtime as the default interception layer for Slack HTTP.
- Use shared factories/fixtures for Slack API responses and inbound webhook/event payloads.
- Remove ad-hoc Slack stubbing patterns (`vi.mock("@slack/web-api")`, direct Slack `fetch` stubs) from integration tests.
- Apply the same MSW harness to eval suites (`evals/`) so all Slack HTTP mocking is consistent.

## Goals
- Keep Slack integration tests deterministic, readable, and network-isolated.
- Make outbound Slack API behavior testable through realistic HTTP contracts.
- Make inbound Slack event/webhook test setup consistent with reusable fixtures.
- Reduce repeated local mocking boilerplate across test files.

## Non-goals
- Replacing live Slack transport/integration tests.
- Rewriting Slack production code paths only to satisfy test ergonomics.
- Introducing browser runtime test requirements.

## Compatibility and Runtime
- Test runtime: Vitest with `environment: "node"`.
- Framework context: Next.js app code executed under Node tests.
- Primary library: `msw` with `msw/node`.
- Applies to both:
  - unit/integration tests (`tests/**/*.test.ts`)
  - eval suites (`evals/**/*.eval.ts`)
- Slack SDK compatibility:
  - `@slack/web-api` requests are HTTP in Node and are intercepted by MSW handlers.
  - Native `fetch` calls to Slack endpoints are also intercepted by MSW handlers.
- If a specific Slack SDK path cannot be reliably intercepted in one scenario, allow a narrowly scoped fallback mock for that scenario only and document why.

## Architecture

### 1) Global MSW server lifecycle
- Add a global setup file for tests that:
  - starts MSW server before all tests,
  - resets handlers/state after each test,
  - closes server after all tests.
- Register this setup in both Vitest configs:
  - `vitest.config.ts`
  - `vitest.evals.config.ts`
- Use strict Slack request handling:
  - unhandled requests to Slack hosts fail tests immediately.
  - non-Slack requests follow current project test behavior.

### 2) Centralized Slack handlers
- Implement shared handlers for Slack API endpoints used by this codebase, including:
  - `chat.postMessage`
  - `chat.getPermalink`
  - `conversations.history`
  - `conversations.members`
  - `conversations.replies`
  - canvas endpoints used by `src/chat/slack-actions/canvases.ts`
  - list endpoints used by `src/chat/slack-actions/lists.ts`
  - file info/upload endpoints used by `src/chat/slack-actions/client.ts`
  - `users.info` used by `src/chat/slack-user.ts`
- Handlers must support:
  - success responses,
  - API error envelopes,
  - pagination with cursors,
  - rate limit responses with retry hints.

### 3) Shared test fixture/factory layer
- Add fixture builders instead of per-test JSON blobs.
- Use deterministic defaults with override support.
- Keep payloads minimal: include only fields consumed by app code and assertions.

## File Layout
- `tests/msw/setup.ts`
  - test lifecycle hooks for MSW server.
- `tests/msw/server.ts`
  - `setupServer(...)` and strict unhandled request policy.
- `tests/msw/handlers/slack-api.ts`
  - outbound Slack API handlers and request inspection utilities.
- `tests/msw/handlers/slack-webhooks.ts`
  - optional reusable inbound webhook fixtures/validators for HTTP route tests.
- `tests/fixtures/slack/factories/api.ts`
  - Slack API response builders (`ok`, `error`, pagination helpers).
- `tests/fixtures/slack/factories/events.ts`
  - inbound Slack event/webhook payload builders.
- `tests/fixtures/slack/factories/ids.ts`
  - deterministic ids/timestamps/thread ids.

## Fixture and Factory Conventions

### API response factories
- Required base helpers:
  - `slackOk(payload)` -> `{ ok: true, ...payload }`
  - `slackError({ error, needed?, provided?, ... })` -> `{ ok: false, error, ... }`
- Endpoint-specific helpers:
  - message posting/permalink
  - thread replies/history pages with `next_cursor`
  - canvas/list create/update/read envelopes
  - user lookup responses

### Inbound event/webhook factories
- Build typed helpers for common Slack event shapes:
  - app mention / message / assistant context events
  - thread metadata with channel/thread IDs
  - slash command payloads as needed
- Default values should be stable and explicit, e.g.:
  - channel IDs like `C_TEST`,
  - thread IDs like `slack:C_TEST:1700000000.000`,
  - user IDs like `U_TEST`.

### Determinism
- Centralize timestamp and ID generation utilities in `ids.ts`.
- Avoid random IDs in assertions unless explicitly testing uniqueness behavior.

## Test Authoring Rules
- Use MSW handlers for any test that validates outbound Slack HTTP behavior.
- Use fixture factories for inbound Slack payload construction.
- Do not directly stub Slack `fetch` endpoints in test files.
- Do not use broad `vi.mock("@slack/web-api")` in integration tests.
- Pure logic/unit tests that do not exercise network contracts may continue using lightweight local stubs.

## State and Isolation
- Add/reset shared handler state per test (recorded requests, queued responses, pagination cursors).
- Add a test-only Slack client reset helper if needed to clear singleton `WebClient` state between tests:
  - `resetSlackClientForTests()` in `src/chat/slack-actions/client.ts`.
- Ensure env var setup for `SLACK_BOT_TOKEN` is centralized in test setup helpers, not duplicated per test.

## Migration Plan (Big-Bang)

### Phase 1: Harness and factories
- Introduce MSW setup, server, handlers, and fixture factories.
- Wire global test setup in:
  - `vitest.config.ts`
  - `vitest.evals.config.ts`

### Phase 2: Convert Slack API wrapper tests
- Migrate tests under Slack action modules first:
  - file upload tests
  - canvas tests
  - channel/list helper tests
  - retry behavior tests

### Phase 3: Convert route and OAuth-related Slack HTTP tests
- Replace direct `globalThis.fetch` Slack stubs with MSW handlers.
- Keep non-Slack external provider mocks scoped as needed.

### Phase 4: Cleanup legacy patterns
- Remove obsolete Slack SDK module mocks and duplicated fixtures.
- Enforce style through review checklist and optional lint rule for Slack test mocks.

## Required Scenarios
- Success flow for each supported Slack API area.
- Error mapping coverage:
  - `missing_scope`
  - `not_in_channel`
  - `invalid_arguments`
  - `not_found`
  - feature unavailability errors
- Retry coverage for rate limits (`429`, retry-after).
- Pagination coverage for message/thread/list readers.
- Failure on unhandled Slack request paths.

## Acceptance Criteria
- Slack integration tests use MSW as default network interception.
- Eval suites that exercise Slack HTTP behavior also use the shared MSW harness.
- Shared fixtures/factories are used for both Slack API responses and inbound events.
- Slack tests run without real Slack network access.
- Existing behavioral assertions remain intact or improve in precision.
- Any non-MSW fallback is explicitly documented in the test file with rationale.

## Risks and Mitigations
- Risk: SDK endpoint behavior drift across `@slack/web-api` upgrades.
  - Mitigation: keep handler utilities close to observed request shape and assert unknown Slack paths fail fast.
- Risk: large migration diff reduces reviewability.
  - Mitigation: keep fixture APIs stable, migrate by module groups inside one PR, and include migration notes.

## Open Questions
- Should we add a dedicated test helper for asserting ordered Slack calls across retries and pagination?
