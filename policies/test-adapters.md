# Test Adapters

## Intent

Tests should be easy to write because the repo gives faithful test adapters for
common edges. They should not invent one-off mocks each time. Django's test
suite is a useful model: it gives tests a client, isolated state, explicit env
overrides, observable outboxes, and runner tools that find leakage.

## Policy

- Start from `policies/testing.md` for layer choice. Use this policy for the
  fixture and adapter shape inside that layer.
- Prefer shared test adapters over one-off mocks when an edge shows up in many
  tests. This matters most for product behavior that crosses runtime, storage,
  inbound handling, or delivery.
- A test adapter should match the production contract closely enough that tests
  can send real payloads and observe the effects.
- Give adapters small role-specific read methods such as `queuedMessages()`,
  `messages()`, or `fileUploads()`. Do not expose broad mutable internals.
- Model external side effects as outboxes or captured deliveries. Reset them
  between tests.
- Model request ingress with signed or request-shaped clients. Do not hand-build
  `Request` objects in every test.
- Model background work with collectors that follow production scheduling.
  Tests must flush that work explicitly.
- Put temporary env or config overrides in helpers that restore state for you.
- Make isolation explicit. Tests that use shared resources, fake clocks,
  singleton state, or process-global config must reset them locally or opt into
  an isolated or serial harness.
- Keep test-only helpers out of production singletons. Prefer injected
  interfaces, local factories, and test adapters over `setForTests` globals or
  module mocks.
- Do not add broad adapter hooks only to unlock a low-level test when an
  existing integration harness can run the real path.
- Add adapter behavior only for a real repeated test need. Name it after the
  user-visible edge, not the implementation trick.
- When a suite fails only under order, shuffle, reverse, or parallel load, treat
  that as a test-isolation bug unless proven otherwise.

## Exceptions

- A local stub is fine for one-off pure unit logic when the edge is not shared
  and the behavior is fixed.
- Module mocks are fine at the one allowed edge for a test layer, such as the
  fixed fake agent edge in integration tests.
- A route harness may delay `waitUntil` work when the contract under test is the
  response or ack edge before background work. Make that delayed flush explicit.
- Very low-level adapter contract tests may inspect raw captured payloads when
  the payload shape itself is the contract under test.
