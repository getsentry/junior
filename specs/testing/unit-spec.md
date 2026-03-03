# Unit Testing Spec

## Intent

Unit tests validate isolated logic with tight control of dependencies.

## Scope

In scope:
- Pure functions and local control-flow logic.
- Module-level invariants (retry/backoff calculations, dedupe trimming, normalization helpers).
- Small adapter wrappers where behavior is deterministic without network contracts.

Out of scope:
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

## Data and Fixtures

- Use shared fixtures for common Slack entities when they improve consistency.
- Avoid random data in assertions unless uniqueness itself is under test.

## Naming and Placement

- Preferred path: `tests/unit/**`.
- Test titles should describe observable unit behavior.

## Required Characteristics

1. No real network calls.
2. Deterministic results across runs.
3. Clear failure messages that localize logic regressions quickly.
