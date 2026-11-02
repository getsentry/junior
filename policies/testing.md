# Testing

## Intent

Tests protect product contracts. They must not block safe internal changes.
Prefer high-fidelity behavior coverage when it is stable.

## Policy

### Layers

- Integration tests own product and runtime behavior. Use real Junior wiring.
  Fake only Slack and LLMs, through the shared harnesses (Slack MSW/outbox
  fixtures and model-stream). Do not mock Junior-owned modules or other
  external edges such as `@vercel/sandbox` or provider SDKs; put those fakes
  in component tests.
- Evals own agent-facing behavior: model reading, continuity, routing, reply
  quality, and tool choice. See `evals.md`.
- Test fixed tool contracts outside the agent. For Slack tools, assert API
  payloads, targets, and attachment serialization in integration tests.
- Unit tests are only for local fixed logic where other layers are much
  slower, less stable, or less diagnostic.
- Fixture and adapter shape: `test-adapters.md`.

### Scope

- Before you add coverage, search every suite for the primary owning scenario
  and extend it.
- A source change does not always need a new test. Existing equal- or
  higher-fidelity coverage that would fail for the regression is enough.
- Give each contract one primary layer. Add another layer only for a distinct
  contract or failure edge.
- Do not add one test per branch. Use one happy path and one realistic failure
  per distinct outcome, safety rule, or irreversible delivery, persistence, or
  recovery edge. Use exhaustive tables only when the input matrix is the
  contract.
- Do not test migrations or migration SQL. Use the schema checks and test the
  resulting behavior.
- Test defensive branches only when untrusted input or migration can reach
  them, they protect a documented stored rule, or they have production
  history.
- Before you finish, prune touched tests that duplicate higher-fidelity
  coverage, mirror branches, or test unreachable cases.

### Mocks and fixtures

- Mock one edge per test, and only the edge the layer allows.
- Prefer shared harnesses, fixtures, memory adapters, MSW handlers, and
  outboxes over ad hoc mocks or local payload schemas.
- Database tests use `tests/fixtures/sql` and `createJuniorSqlFixture`. Only
  migration contract tests use an empty fixture. Do not import Postgres
  fixture internals.

### Assertions

- Assert user-visible outcomes and external contracts first. Telemetry is not
  a contract outside instrumentation tests.
- Use `toMatchInlineSnapshot` for multi-line rendered text.
- Do not assert static strings in system or turn-context prompts. Assert only
  generated values.

### UI and browser

- Most visual changes need no automated test. QA them manually and attach
  visual evidence.
- Add UI coverage only for a behavior contract: navigation, interaction,
  accessibility state, request or response shape, auth gating, or a realistic
  failure path.
- Browser E2E covers critical journeys only, one representative path each.
  It is not a catalog of states.
- Assert the outcome the journey names. Do not fail on unrelated console or
  page errors.
- Do not assert CSS classes, DOM tag counts, markup, pixel geometry, size, or
  computed style.
- No fixed sleeps. Wait for the visible state, URL, request, or response.

## Exceptions

- Unit tests fit pure parsing, normalization, retry math, scoring, and small
  fixed transforms.
- Component tests fit fixed cross-module contracts that do not need full
  product wiring.
- Low-level contract tests may inspect payloads when the payload shape is the
  external contract.
