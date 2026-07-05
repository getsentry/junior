# Testing

## Intent

Tests should protect product contracts without freezing implementation details.
Prefer higher-fidelity behavior coverage when it is deterministic enough, so
routine refactors do not churn brittle unit tests.

## Policy

- Prefer integration tests for product/runtime behavior when the contract can be
  proven through real wiring with only the allowed fake boundary.
- Prefer evals for agent-facing behavior that depends on model interpretation,
  continuity, routing, or reply quality.
- Test tool implementations outside the agent flow when their contract is
  deterministic. For Slack tools, use integration tests with outbound mocks for
  API payloads, target coordinates, and attachment serialization; use evals only
  for whether the agent selects the correct tool, target, and reply strategy.
- Use unit tests only for tightly local deterministic logic where integration or
  eval coverage would be materially slower, less deterministic, or less
  diagnostic.
- Do not add unit tests as duplicate confidence for behavior already covered by
  integration or eval tests.
- Delete or avoid unit tests that mainly mirror helper branches behind a
  user-visible behavior contract.
- Keep coverage proportional: one representative happy path, one realistic
  failure or policy guardrail, and edge cases only when they have production
  history or meaningfully different safety/routing semantics.
- Mock one boundary per test, and only the boundary allowed for that test layer.
  Do not stack mocks across persistence, runtime, delivery, and reply execution
  to simulate a product workflow.
- Prefer existing harnesses, shared fixtures, memory adapters, MSW handlers, and
  outboxes over ad hoc mocks or local payload schemas.
- Assert user-visible outcomes and external contracts before implementation
  details. Logs, spans, and status telemetry are not behavior contracts unless
  the test is explicitly about instrumentation.

## Exceptions

- A unit test is appropriate for pure parsing, normalization, retry math,
  scoring, small deterministic transforms, and local algorithmic invariants.
- A component test is appropriate for deterministic service/runtime contracts
  that cross modules but do not need full product wiring.
- Very low-level contract tests may inspect implementation-shaped payloads when
  the payload shape itself is the external contract.
