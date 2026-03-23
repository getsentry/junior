# Unit Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-22

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated unit test path references to repo-root paths under `packages/junior/`.
- 2026-03-04: Normalized section shape by introducing explicit `Non-Goals`.
- 2026-03-17: Clarified that unit tests should not treat internal logs and telemetry as behavior contracts.
- 2026-03-22: Clarified that unit tests are the last-choice layer for local invariants, not the default for runtime behavior.

## Intent

Unit tests validate isolated logic with tight control of dependencies. They are the last-choice layer for chat behavior work and should only be used when higher-fidelity integration or eval coverage would not add confidence.

## Scope

In scope:

- Pure functions and local control-flow logic.
- Module-level invariants (retry/backoff calculations, dedupe trimming, normalization helpers).
- Small adapter wrappers where behavior is deterministic without network contracts.

## Non-Goals

- Slack HTTP request/response contract validation.
- Full runtime Slack event handling behavior.
- Conversational quality and multi-turn judge-scored outcomes.

## Mocking Policy

Allowed:

- `vi.mock`, local fakes, and spies.
- Dependency stubs for clocks, random IDs, and boundary services.

Recommended:

- Keep the mocked surface minimal.
- Assert behavior at module outputs rather than internal calls where practical.
- Do not treat logger or tracer calls as required behavior unless the test is explicitly validating instrumentation.

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
