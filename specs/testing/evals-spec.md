# Eval (E2E Behavior) Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-04-21

## Changelog

- 2026-04-21: Described evals as the integration-style layer for agent-facing behavior and clarified the boundary against ordinary runtime/product integration tests.
- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Normalized section shape by introducing explicit `Non-Goals`.
- 2026-03-20: Added natural-prompt authoring rule and explicit ban on scripting internal commands/tools into eval prompts.
- 2026-03-22: Clarified that evals are the preferred layer for end-to-end behavior when model behavior is part of the contract.
- 2026-04-16: Standardized eval judge criteria on a structured rubric format so cases and failures stay human-readable for maintainers.

## Intent

Evals validate end-to-end conversational behavior outcomes through the runtime harness and LLM-judged criteria. Treat them as the integration-style layer for agent-facing behavior: use them when the contract depends on natural-language interpretation, continuity, prompt behavior, or reply quality.

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
3. Express expectations through the structured rubric shape used by `rubric({ contract, pass, allow, fail })`.
4. Every new or edited eval must keep its rubric human-readable to maintainers.
   `contract` states the user-visible behavior being proven.
   `pass` lists the observable pass conditions.
   `allow` lists acceptable optional variations.
   `fail` lists failure conditions or forbidden output.
5. Do not write judge criteria as one dense paragraph.
6. Let the `describe()` block own the behavior area. The file path and `describe()` context already provide scope, so each individual eval name should only state the specific scenario and outcome.
7. Prefer `when <trigger>, <outcome>` over vague labels like `continuity: remembers prior turn context`.
8. Avoid asserting tool-internal mechanics unless explicitly user-visible.
9. Keep user prompts natural and product-realistic. Do not script exact internal commands, tool names, or implementation steps into the prompt just to force a path.
10. If a case only works when the prompt prescribes internal mechanics, treat that as an eval-design failure or product-behavior gap, not a passing eval.
11. If a case uses harness-controlled decision fixtures such as subscribed-message reply gating, do not claim those gated behaviors are being validated by the eval outcome.

## Boundaries

Do not in eval files:

- Import Slack action internals for direct contract assertions.
- Use MSW queue/capture helpers intended for integration contract tests.
- Rely on implementation-only identifiers (exact internal tool names, opaque IDs) unless the case intentionally evaluates that surface.
- Encode exact internal commands or tool choices in user prompts when the contract under test is higher-level conversational behavior.

## Relationship to Other Layers

- Integration tests own Slack HTTP contract assertions and most runtime/product wiring.
- Integration tests own real runtime behavior when a deterministic fake agent is sufficient and the contract is not model interpretation itself.
- Unit tests own isolated deterministic logic invariants.
- Evals own agent-facing conversational outcomes across realistic flows and replace ordinary integration tests for that surface.

## When To Choose Evals

Use evals when:

1. The behavior depends on the model interpreting user language correctly.
2. The behavior is about reply quality, continuity, passive participation, or natural-language routing rather than transport wiring.
3. Lower-fidelity integration coverage would only prove a mocked version of the real contract.

Do not choose evals for ordinary Slack payload-shape assertions, deterministic resume wiring, or handler contracts that integration tests can prove directly.

## Execution

Operational commands and harness details live in `packages/junior-evals/README.md`.

The eval artifact contract should preserve user-visible output structure. In particular, assistant thread posts must retain attachment metadata instead of flattening attachments into synthetic text.
Eval output should also stay readable in failure reports. Preserve the structured JSON shape instead of collapsing it into prose or synthetic summaries.
