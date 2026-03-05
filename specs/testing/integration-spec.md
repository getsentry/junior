# Integration Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-04

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated integration fixture and MSW path references to repo-root paths under `packages/junior/`.
- 2026-03-04: Normalized section shape by introducing explicit `Non-Goals`.


## Intent

Integration tests validate real runtime wiring and Slack-facing behavior, with deterministic control only at the agent boundary.

## Scope

In scope:
- Slack event ingestion and routing behavior.
- Runtime orchestration and state interactions.
- Slack HTTP contracts (request shape, retries, error mapping) through MSW.
- Behavior outcomes from real runtime flow using deterministic fake-agent outputs.

## Non-Goals

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

1. Use `packages/junior/tests/fixtures/slack/*` factories and harness helpers.
2. Use `packages/junior/tests/msw/*` handler utilities for Slack API sequencing and assertions.
3. Prefer scenario-style tests that drive events and assert resulting user-visible outputs + captured Slack API calls.

## Classification Guidance

If a test relies on runtime module mocks to drive control-flow branches, classify it as unit (not integration).

## Core Scenarios to Cover

1. Mention and subscribed-thread routing behavior.
2. Rapid same-thread message ordering/continuity.
3. Error handling that remains user-visible and non-silent.
4. Slack API contract correctness for tools/actions used by runtime paths.
5. Context-bound tool targeting behavior (harness-resolved targets, no model-selected destination overrides).

## Workflow Coverage Requirements

Integration tests that cover workflow ingress/execution must assert workflow-boundary behavior, not just handler internals:

1. Verify ingress payloads sent to workflow routing are serializable and contain serialized `chat:Message` / `chat:Thread` data (no function-valued fields).
2. Exercise the real message-kind routing behavior (`new_mention` vs `subscribed_message`) through `routeIncomingMessageToWorkflow(...)`.
3. Validate de-dup behavior on ingress and de-dup behavior in workflow stream processing.

## Context-Bound Tool Coverage Requirements

For tools governed by harness context (for example Slack channel/canvas/list operations):

1. Assert destination/target comes from harness/runtime context rather than model-supplied IDs.
2. Assert missing context fails safely with actionable error responses.
3. Assert disallowed fallback scopes (for example bot-private artifacts for shared deliverables) are not used.

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
