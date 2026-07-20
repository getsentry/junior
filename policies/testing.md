# Testing

## Intent

Tests should protect product contracts without freezing implementation details.
Prefer higher-fidelity behavior coverage when it is deterministic enough, so
routine refactors do not churn brittle unit tests.

## Policy

- Prefer integration tests for product/runtime behavior when the contract can be
  proven through real wiring with only the allowed fake boundary.
- Prefer evals for agent-facing behavior that depends on model interpretation,
  continuity, routing, or reply quality. Assert through normalized session,
  tool, and artifact surfaces; deterministic persistence belongs in integration
  tests.
- Test tool implementations outside the agent flow when their contract is
  deterministic. For Slack tools, use integration tests with outbound mocks for
  API payloads, target coordinates, and attachment serialization; use evals only
  for whether the agent selects the correct tool, target, and reply strategy.
- Use unit tests only for tightly local deterministic logic where integration or
  eval coverage would be materially slower, less deterministic, or less
  diagnostic.
- Give each behavior contract one primary owning layer. Add cross-layer
  coverage only for a distinct contract or materially different failure
  boundary, not as duplicate confidence.
- Keep coverage proportional: one representative happy path and one realistic
  failure per distinct product outcome, safety invariant, or irreversible
  delivery, persistence, migration, or recovery boundary. Consolidate examples
  of the same invariant and interchangeable mock failure sources.
- Test defensive branches only when the state is reachable through untrusted
  input or migration, protects a schema-enforced or documented persisted
  invariant, or has production history.
- Mock one boundary per test, and only the boundary allowed for that test layer.
  Do not stack mocks across persistence, runtime, delivery, and reply execution
  to simulate a product workflow.
- Prefer existing harnesses, shared fixtures, memory adapters, MSW handlers, and
  outboxes over ad hoc mocks or local payload schemas.
- Assert user-visible outcomes and external contracts before implementation
  details. Logs, spans, and status telemetry are not behavior contracts unless
  the test is explicitly about instrumentation.
- Do not assert CSS utility strings, raw DOM tag counts, or generated markup to
  prove visual styling. Test semantic state and interaction behavior with
  component or browser coverage, and validate styling-only changes visually.
- Before completing a non-trivial change, prune touched tests that are
  superseded by equal- or higher-fidelity coverage, merely mirror implementation
  branches without a distinct contract, or exercise equivalent or unreachable
  cases.

## Exceptions

- A unit test is appropriate for pure parsing, normalization, retry math,
  scoring, small deterministic transforms, and local algorithmic invariants.
- A component test is appropriate for deterministic service/runtime contracts
  that cross modules but do not need full product wiring.
- Very low-level contract tests may inspect implementation-shaped payloads when
  the payload shape itself is the external contract.
