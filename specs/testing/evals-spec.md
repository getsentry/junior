# Eval (E2E Behavior) Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-03

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.


## Intent

Evals validate end-to-end conversational behavior outcomes through the runtime harness and LLM-judged criteria.

## Scope

In scope:
- Multi-turn conversational behavior.
- User-visible response quality and continuity.
- Lifecycle/resilience behavior as observed by users.

Out of scope:
- Low-level Slack Web API request payload shape assertions.
- Internal implementation details not observable to end users.

## Authoring Rules

1. Define cases via `slackEval()` and event builders.
2. Keep each case focused on one primary behavior outcome.
3. Express expectations in natural-language criteria.
4. Avoid asserting tool-internal mechanics unless explicitly user-visible.

## Boundaries

Do not in eval files:
- Import Slack action internals for direct contract assertions.
- Use MSW queue/capture helpers intended for integration contract tests.
- Rely on implementation-only identifiers (exact internal tool names, opaque IDs) unless the case intentionally evaluates that surface.

## Relationship to Other Layers

- Integration tests own Slack HTTP contract assertions.
- Unit tests own isolated logic invariants.
- Evals own conversational outcome quality across realistic flows.

## Execution

Operational commands and harness details live in `evals/README.md`.
