# Unit Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-06-05

## Intent

Unit tests validate isolated logic with tight control of dependencies. Use them for algorithm-type things and tightly local deterministic invariants. They are not the default for runtime/product behavior.

## Scope

In scope:

- Pure functions and local control-flow logic.
- Module-level invariants such as retry/backoff calculations, dedupe trimming, normalization helpers, scoring/routing heuristics, and pure transforms.
- Small adapter wrappers where behavior is deterministic without network contracts.

## Non-Goals

- Real handler/runtime flows that rebuild thread state, call Slack APIs, or exercise multi-module orchestration.
- Deterministic multi-module service contracts better covered by component tests.
- Slack HTTP request/response contract validation.
- Full runtime Slack event handling behavior.
- Conversational quality and multi-turn judge-scored outcomes.

## Mocking Policy

Allowed:

- Local fakes and spies for one explicit boundary.
- `vi.mock` only when the real dependency is a third-party SDK/client, nondeterministic system boundary, or the local invariant cannot be exercised through an injected port.
- Dependency stubs for clocks, random IDs, and boundary services.

Recommended:

- Default to no module mocks. If a unit test repeatedly needs an internal module mock, extract a small adapter/fixture or move the contract to a component test.
- Do not add production dependency bags just to replace basic runtime behavior. Exercise filesystem code with temp directories, time-sensitive code with Vitest fake timers, env-sensitive code with env stubs, and pure code through ordinary function inputs.
- Keep the mocked surface minimal.
- Mock one boundary for one local invariant; do not stack mocks across persistence, Slack delivery, and reply execution just to simulate an end-to-end flow.
- Assert behavior at module outputs rather than internal calls where practical.
- Do not mock logging, Sentry capture, or span/tracing modules outside rare logging contract tests under `tests/unit/logging/**`.
- Do not treat logger or tracer calls as required behavior outside rare logging contract tests under `tests/unit/logging/**`.
- Do not unit test prompt builders by asserting exact or substring prompt prose. If prompt wording matters, cover the resulting user-visible behavior with evals or integration tests.
- If a test has to mock large parts of the runtime or Slack client to prove a user-visible flow, reclassify it as component, integration, or eval instead of growing the unit seam.

## Data and Fixtures

- Use shared fixtures for common Slack entities when they improve consistency.
- Avoid random data in assertions unless uniqueness itself is under test.

## Naming and Placement

- Preferred path: `packages/junior/tests/unit/**`.
- Test titles should describe observable unit behavior.
- Split large unit suites by the local contract under test even when they share
  a setup fixture. Shared package/filesystem builders belong in
  `tests/fixtures/**`; manifest parsing, validation, env interpolation, and
  adapter metadata should remain separate suites.

## Required Characteristics

1. No real network calls.
2. Deterministic results across runs.
3. Clear failure messages that localize logic regressions quickly.
4. A unit test should fail because one local invariant broke, not because an end-to-end workflow changed shape.
