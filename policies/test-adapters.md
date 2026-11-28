# Test Adapters

## Intent

Shared test adapters for common edges make tests easy to write. Tests should
not invent one-off mocks. Adapters give a client, isolated state, explicit env
overrides, observable outboxes, and tools that find leakage.

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
- Put temporary env overrides in helpers that restore state for you. Put
  config in the app context that the test builds.
- Each test builds the app context and the resources that it uses, and closes
  them. Do not use per-file isolation or a serial harness to reset singleton
  state or process-global config. Remove the global.
- Keep test-only helpers out of production code. Do not add `setForTests`
  globals. Mocks: `testing.md`.
- Do not add broad adapter hooks only to unlock a low-level test when an
  existing integration harness can run the real path.
- Add adapter behavior only for a real repeated test need. Name it after the
  user-visible edge, not the implementation trick.
- When a suite fails only under order, shuffle, reverse, or parallel load, treat
  that as a test-isolation bug unless proven otherwise.

## Exceptions

- A local stub is fine for one-off pure unit logic when the edge is not shared
  and the behavior is fixed.
- In component tests, a module mock is fine for an external package edge,
  such as `@vercel/sandbox` or a provider SDK, when no shared harness covers
  it.
- A route harness may delay `waitUntil` work when the contract under test is the
  response or ack edge before background work. Make that delayed flush explicit.
- Very low-level adapter contract tests may inspect raw captured payloads when
  the payload shape itself is the contract under test.
