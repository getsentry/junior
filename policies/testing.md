# Testing

## Intent

Tests should protect product contracts. They should not prevent safe changes to internal code.
Prefer higher-fidelity behavior coverage when it is stable enough. Routine
refactors should not churn brittle unit tests.

## Policy

- Prefer integration tests for product and runtime behavior when the contract
  can be proven through real wiring with only the allowed fake edge.
- Prefer evals for agent-facing behavior that depends on model reading,
  continuity, routing, or reply quality. Assert through normalized session,
  tool, and artifact surfaces. Fixed persistence belongs in integration tests.
- Test tool implementations outside the agent flow when their contract is fixed.
  For Slack tools, use integration tests with outbound mocks for API payloads,
  target coordinates, and attachment serialization. Use evals only for whether
  the agent picks the right tool, target, and reply strategy.
- Use unit tests only for tightly local fixed logic where integration or eval
  coverage would be much slower, less stable, or less diagnostic.
- Before adding coverage, search unit, component, integration, and eval suites
  for the behavior's primary owning scenario. Extend that scenario. Do not add
  nearby coverage around the changed implementation.
- A source change does not automatically need a new test. Existing coverage is
  enough when an equal- or higher-fidelity test exercises the changed contract
  and would fail for the regression being blocked.
- Give each behavior contract one primary owning layer. Add cross-layer coverage
  only for a distinct contract or a clearly different failure edge, not as
  duplicate confidence.
- Do not add one test per implementation branch. Use representative cases for
  product behavior. Reserve exhaustive tables for local fixed rules where the
  full input matrix is itself the contract.
- Keep coverage proportional: one representative happy path and one realistic
  failure per distinct product outcome, safety rule, or irreversible delivery,
  persistence, migration, or recovery edge. Merge examples of the same rule and
  interchangeable mock failure sources.
- Test defensive branches only when the state is reachable through untrusted
  input or migration, protects a schema-enforced or documented stored rule, or
  has production history.
- Mock one edge per test, and only the edge allowed for that test layer. Do not
  stack mocks across persistence, runtime, delivery, and reply execution to fake
  a product workflow.
- Integration tests must not mock Junior-owned modules. Compose real Junior
  wiring and fake only the external edge named by the test harness.
- Prefer existing harnesses, shared fixtures, memory adapters, MSW handlers, and
  outboxes over ad hoc mocks or local payload schemas.
- Assert user-visible outcomes and external contracts before implementation
  details. Logs, spans, and status telemetry are not behavior contracts unless
  the test is explicitly about instrumentation.
- Prefer `toMatchInlineSnapshot` for multi-line generated agent inputs or other
  rendered text contracts. Keep the full expected output next to the assertion.
- Do not assert that static strings are present in normal system or turn-context
  prompts. Assert generated values only, such as dispatch input built from task
  data or other rendered outputs under test.
- Browser E2E tests protect critical user journeys that need a real browser.
  Keep one representative path for navigation, interaction, accessibility
  state, request contracts, and realistic failure recovery. Do not use browser
  E2E as a catalog of every visible state or implementation branch.
- Assert the outcome named by the browser journey. Do not fail a journey because
  the browser emitted unrelated console or page errors. Test an error only when
  it is the user-visible outcome or external contract that the journey owns.
- Do not assert CSS utility strings, raw DOM tag counts, generated markup,
  pixel geometry, element size, or computed style to prove visual styling.
  Test semantic state and interaction behavior with component or browser
  coverage, and validate layout and styling through visual QA.
- Do not add fixed sleeps to browser E2E tests. Wait for the user-visible state,
  URL, request, or response that proves the behavior.
- Most visual changes need no new automated test. Layout, styling, spacing,
  theme, copy presentation, and other look-and-feel work should be manually
  QA'd. Include the visual evidence in the change. Do not add unit, component,
  snapshot, browser E2E, or other regression tests just because a UI file
  changed.
- UI changes do not require browser E2E coverage when they only change layout,
  styling, copy, or already-covered presentation. Use visual QA instead.
- Add automated UI coverage only when the change owns a product behavior
  contract such as navigation, interaction, accessibility state, request or
  response shape, auth gating, or a realistic failure path. Extend the primary
  owning scenario. Do not invent a nearby case for confidence.
- Before you finish a non-trivial change, prune touched tests that equal- or
  higher-fidelity coverage already covers, only mirror implementation branches
  without a distinct contract, or exercise equivalent or unreachable cases.

## Exceptions

- A unit test is right for pure parsing, normalization, retry math, scoring,
  small fixed transforms, and local algorithmic rules.
- A component test is right for fixed service or runtime contracts that cross
  modules but do not need full product wiring.
- Very low-level contract tests may inspect implementation-shaped payloads when
  the payload shape itself is the external contract.
