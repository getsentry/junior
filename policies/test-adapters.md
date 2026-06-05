# Test Adapters

## Intent

Tests should be easy to write because the repo provides faithful test adapters for common boundaries, not because each test invents its own mocks. Django's test suite is a useful model: it gives tests a client, isolated state, explicit environment overrides, observable outboxes, and runner tools for finding leakage.

## Policy

- Start from `specs/testing.md` for layer selection; use this policy for the fixture and adapter shape inside that layer.
- Prefer shared test adapters over one-off mocks when a boundary recurs across tests.
- Default to real modules and no mocks. Reach for a mock only after the real module, shared adapter, MSW handler, or explicit injected port cannot express the contract clearly.
- A test adapter should implement the production-facing contract closely enough that tests can inject real payloads and observe resulting effects.
- Give adapters small, role-specific introspection methods such as `queuedMessages()`, `messages()`, or `fileUploads()`. Do not expose broad mutable internals.
- Model external side effects as outboxes or captured deliveries that are reset between tests.
- Model request ingress with signed/request-shaped clients instead of hand-built `Request` objects in every test.
- Model background work with collectors that follow production scheduling semantics and require tests to flush explicitly.
- Centralize temporary environment or configuration overrides in helpers that restore state automatically.
- Use `packages/junior/tests/fixtures/vitest.ts` for common Vitest lifecycle concerns such as env stubs, memory-state isolation, and fake-timer cleanup.
- Make isolation explicit. Tests that use shared resources, fake clocks, singleton state, or process-global configuration must reset them locally or opt into an isolated/serial harness.
- Keep test-only capabilities out of production singletons. Prefer injected ports, local factories, and test adapters over `setForTests` globals or module mocks.
- Integration tests must use explicit composition or named harness ports for deterministic agent/model behavior; do not use module mocks to alter runtime wiring.
- Treat module mocks as rare. They should usually target third-party services, SDK clients, nondeterministic system boundaries, or one explicit injected port in a unit/component test.
- Do not mock logging, Sentry capture, span capture, or tracing helpers to quiet tests or avoid setup. Real telemetry should run through ordinary behavior tests.
- If telemetry output must be inspected, keep it rare, put it in a dedicated logging contract test under `tests/unit/logging/**`, and mock only the minimal Sentry/span primitive needed to observe stable semantic behavior.
- Add adapter behavior only for a real recurring test need, and keep it named after the user-visible boundary rather than the implementation mechanism.
- Keep shared adapter contract tests in dedicated files named for the adapter or
  port contract. Do not mix test-adapter self-tests into product behavior suites.
- When a suite fails only under order, shuffle, reverse, or parallel load, treat that as a test-isolation bug unless proven otherwise.

## Exceptions

- A local stub is acceptable for one-off pure unit logic when the boundary is not shared and the behavior is deterministic.
- Module mocks are acceptable at the one explicitly allowed boundary for unit and component tests; integration tests must use explicit ports instead.
- Logging contract tests under `tests/unit/logging/**` may substitute telemetry primitives when the emitted logging/span/capture shape is the behavior under test.
- A route harness may defer `waitUntil` execution when the contract under test is the response/ack boundary before background work; make the deferred flush explicit.
- Very low-level adapter contract tests may inspect raw captured payloads when the payload shape itself is the contract under test.
