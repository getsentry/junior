# Unit Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-04-21

## Changelog

- 2026-04-21: Narrowed unit scope around local deterministic logic and clarified that mocked end-to-end handler/runtime flows should move to integration or eval instead.
- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated unit test path references to repo-root paths under `packages/junior/`.
- 2026-03-04: Normalized section shape by introducing explicit `Non-Goals`.
- 2026-03-17: Clarified that unit tests should not treat internal logs and telemetry as behavior contracts.
- 2026-03-22: Clarified that unit tests are the last-choice layer for local invariants, not the default for runtime behavior.
- 2026-03-25: Banned unit tests that assert prompt prose or substring presence in generated prompts.

## Intent

Unit tests validate isolated logic with tight control of dependencies. Use them for algorithm-type things and tightly local deterministic invariants. They are not the default for runtime/product behavior.

## Scope

In scope:

- Pure functions and local control-flow logic.
- Module-level invariants such as retry/backoff calculations, dedupe trimming, normalization helpers, scoring/routing heuristics, and pure transforms.
- Small adapter wrappers where behavior is deterministic without network contracts.

## Non-Goals

- Real handler/runtime flows that rebuild thread state, call Slack APIs, or exercise multi-module orchestration.
- Slack HTTP request/response contract validation.
- Full runtime Slack event handling behavior.
- Conversational quality and multi-turn judge-scored outcomes.

## Mocking Policy

Allowed:

- `vi.mock`, local fakes, and spies.
- Dependency stubs for clocks, random IDs, and boundary services.

Recommended:

- Keep the mocked surface minimal.
- Mock one boundary for one local invariant; do not stack mocks across persistence, Slack delivery, and reply execution just to simulate an end-to-end flow.
- Assert behavior at module outputs rather than internal calls where practical.
- Do not treat logger or tracer calls as required behavior unless the test is explicitly validating instrumentation.
- Do not unit test prompt builders by asserting exact or substring prompt prose. If prompt wording matters, cover the resulting user-visible behavior with evals or integration tests.
- If a test has to mock large parts of the runtime or Slack client to prove a user-visible flow, reclassify it as integration or eval instead of growing the unit seam.

## Data and Fixtures

- Use shared fixtures for common Slack entities when they improve consistency.
- Avoid random data in assertions unless uniqueness itself is under test.

## Naming and Placement

- Preferred path: `packages/junior/tests/unit/**`.
- Test titles should describe observable unit behavior.

## Required Characteristics

1. No real network calls.
2. Deterministic results across runs.
3. Clear failure messages that localize logic regressions quickly.
4. A unit test should fail because one local invariant broke, not because an end-to-end workflow changed shape.
