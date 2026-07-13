# Test Adapters

## Intent

Tests should be easy to write because the repo provides faithful test adapters for common boundaries, not because each test invents its own mocks. Django's test suite is a useful model: it gives tests a client, isolated state, explicit environment overrides, observable outboxes, and runner tools for finding leakage.

## Policy

- Start from `policies/testing.md` for layer selection; use this policy for the fixture and adapter shape inside that layer.
- Prefer shared test adapters over one-off mocks when a boundary recurs across tests, especially for product behavior that crosses runtime, persistence, ingress, or delivery boundaries.
- A test adapter should implement the production-facing contract closely enough that tests can inject real payloads and observe resulting effects.
- Give adapters small, role-specific introspection methods such as `queuedMessages()`, `messages()`, or `fileUploads()`. Do not expose broad mutable internals.
- Model external side effects as outboxes or captured deliveries that are reset between tests.
- Model request ingress with signed/request-shaped clients instead of hand-built `Request` objects in every test.
- Model background work with collectors that follow production scheduling semantics and require tests to flush explicitly.
- Centralize temporary environment or configuration overrides in helpers that restore state automatically.
- Make isolation explicit. Tests that use shared resources, fake clocks, singleton state, or process-global configuration must reset them locally or opt into an isolated/serial harness.
- Keep test-only capabilities out of production singletons. Prefer injected ports, local factories, and test adapters over `setForTests` globals or module mocks.
- Do not add broad adapter hooks only to make a low-level test possible when an existing integration harness can exercise the real path.
- Add adapter behavior only for a real recurring test need, and keep it named after the user-visible boundary rather than the implementation mechanism.
- When a suite fails only under order, shuffle, reverse, or parallel load, treat that as a test-isolation bug unless proven otherwise.

## Exceptions

- A local stub is acceptable for one-off pure unit logic when the boundary is not shared and the behavior is deterministic.
- Module mocks are acceptable at the one explicitly allowed boundary for a test layer, such as the deterministic fake agent boundary in integration tests.
- A route harness may defer `waitUntil` execution when the contract under test is the response/ack boundary before background work; make the deferred flush explicit.
- Very low-level adapter contract tests may inspect raw captured payloads when the payload shape itself is the contract under test.
