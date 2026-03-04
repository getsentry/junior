# Anti-Patterns and Fixes

Use this document to avoid invalid Slack integration test patterns.

## Anti-pattern: Mocking Slack SDK module directly

Bad:

```ts
vi.mock("@slack/web-api", ...)
```

Fix:

- Use the real module under test.
- Queue HTTP responses with `queueSlackApiResponse(...)`.
- Assert captured request payloads with `getCapturedSlackApiCalls(...)`.

## Anti-pattern: Mocking `@/chat/slack-actions/client` in HTTP contract tests

Bad:

```ts
vi.mock("@/chat/slack-actions/client", ...)
```

Fix:

- Do not bypass the Slack HTTP layer.
- Exercise full client call path through MSW handlers.

## Anti-pattern: Stubbing `globalThis.fetch` for Slack hosts

Bad:

```ts
globalThis.fetch = vi.fn(...)
```

Fix:

- Let MSW intercept Slack host traffic.
- Use `queueSlackApiResponse` and endpoint fixtures.

## Anti-pattern: Ad hoc Slack payload objects repeated per test

Bad:

- Large inline JSON blobs duplicated across files.

Fix:

- Reuse fixture builders from `tests/fixtures/slack/factories/api.ts`.
- Override only fields needed for each assertion.

## Anti-pattern: Asserting only return value

Bad:

- Test checks only return object and does not validate outbound Slack request shape.

Fix:

- Assert both behavior and outbound request payloads.
- Confirm endpoint selection, argument shape, and call count.

## Anti-pattern: Recreating MSW setup per test file

Bad:

- Creating local `setupServer(...)` and lifecycle hooks inside each test file.

Fix:

- Use the shared global setup already configured in `tests/msw/setup.ts`.
- Keep individual files focused on queueing responses and assertions.
