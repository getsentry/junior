# Integration Testing Spec

## Intent

Integration tests validate real runtime wiring and Slack-facing behavior, with deterministic control only at the agent boundary.

## Scope

In scope:
- Slack event ingestion and routing behavior.
- Runtime orchestration and state interactions.
- Slack HTTP contracts (request shape, retries, error mapping) through MSW.
- Behavior outcomes from real runtime flow using deterministic fake-agent outputs.

Out of scope:
- Pure algorithmic invariants better covered by unit tests.
- Judge-scored conversational quality (belongs to evals).

## Required Runtime Shape

1. Use real app/runtime modules for behavior paths.
2. Use MSW handlers and Slack fixtures for outbound Slack HTTP.
3. Keep persistence/routing code real unless the test is explicitly categorized as unit.

## Substitution Policy

Allowed:
- Fake agent substitution at the agent boundary only (`setBotDepsForTests` / `resetBotDepsForTests`, or approved wrapper helpers).

Disallowed in integration behavior tests:
- `vi.mock` for runtime behavior modules (`@/chat/state`, workflow router/runtime handlers, webhook patching paths, etc.).
- Ad-hoc stubbing of Slack HTTP fetch/webclient internals in test files.

## Fixture and Harness Rules

1. Use `tests/fixtures/slack/*` factories and harness helpers.
2. Use `tests/msw/*` handler utilities for Slack API sequencing and assertions.
3. Prefer scenario-style tests that drive events and assert resulting user-visible outputs + captured Slack API calls.

## Classification Guidance

If a test relies on runtime module mocks to drive control-flow branches, classify it as unit (not integration).

## Core Scenarios to Cover

1. Mention and subscribed-thread routing behavior.
2. Rapid same-thread message ordering/continuity.
3. Error handling that remains user-visible and non-silent.
4. Slack API contract correctness for tools/actions used by runtime paths.

## Scope Discipline (Do Not Over-Test)

Integration tests should prove wiring and external behavior contracts, not exhaust every edge-case permutation.

Required approach:
1. Cover one representative happy path per runtime contract.
2. Add failure-path coverage only for distinct, realistic regressions.
3. Add edge-case coverage when:
   - the behavior has caused production bugs before, or
   - the edge case changes routing/safety semantics.

Avoid:
1. Duplicating the same assertion across multiple near-identical payload variants.
2. Asserting internal call choreography that is not part of the contract.
3. Encoding speculative edge cases with no concrete bug history or risk signal.

## Enforcement

`pnpm run test:slack-boundary` enforces integration boundary policy for designated behavior integration tests.
