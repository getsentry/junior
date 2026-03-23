# Eval (E2E Behavior) Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-22

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Normalized section shape by introducing explicit `Non-Goals`.
- 2026-03-20: Added natural-prompt authoring rule and explicit ban on scripting internal commands/tools into eval prompts.
- 2026-03-22: Clarified that evals are the preferred layer for end-to-end behavior when model behavior is part of the contract.

## Intent

Evals validate end-to-end conversational behavior outcomes through the runtime harness and LLM-judged criteria. They are the preferred test layer for user-visible product behavior when the model is part of the contract.

## Scope

In scope:

- Multi-turn conversational behavior.
- User-visible response quality and continuity.
- Lifecycle/resilience behavior as observed by users.

## Non-Goals

- Low-level Slack Web API request payload shape assertions.
- Internal implementation details not observable to end users.

## Authoring Rules

1. Define cases via `slackEval()` and event builders.
2. Keep each case focused on one primary behavior outcome.
3. Express expectations in natural-language criteria.
4. Avoid asserting tool-internal mechanics unless explicitly user-visible.
5. Keep user prompts natural and product-realistic. Do not script exact internal commands, tool names, or implementation steps into the prompt just to force a path.
6. If a case only works when the prompt prescribes internal mechanics, treat that as an eval-design failure or product-behavior gap, not a passing eval.
7. If a case uses harness-controlled decision fixtures such as subscribed-message reply gating, do not claim those gated behaviors are being validated by the eval outcome.

## Boundaries

Do not in eval files:

- Import Slack action internals for direct contract assertions.
- Use MSW queue/capture helpers intended for integration contract tests.
- Rely on implementation-only identifiers (exact internal tool names, opaque IDs) unless the case intentionally evaluates that surface.
- Encode exact internal commands or tool choices in user prompts when the contract under test is higher-level conversational behavior.

## Relationship to Other Layers

- Integration tests own Slack HTTP contract assertions.
- Integration tests own real runtime behavior when a deterministic fake agent is sufficient.
- Unit tests own isolated logic invariants.
- Evals own conversational outcome quality across realistic flows.

## Execution

Operational commands and harness details live in `evals/README.md`.

The eval artifact contract should preserve user-visible output structure. In particular, assistant thread posts must retain attachment metadata instead of flattening attachments into synthetic text.
