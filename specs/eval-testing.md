# Eval (E2E Behavior) Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-06-18

## Intent

Evals validate end-to-end conversational behavior outcomes through the runtime harness and LLM-judged criteria. Treat them as the integration-style layer for agent-facing behavior: use them when the contract depends on natural-language interpretation, continuity, prompt behavior, or reply quality. The Slack eval judge uses the same harness prompt seam as the suite, backed by Junior's Pi client and Vercel AI Gateway.

The normalized `vitest-evals` session is the canonical eval surface. Judges and deterministic assertions should use `result.session`, `toolCalls(result.session)`, artifacts, and traces before introducing any repo-local output schema. If a case needs a fully ordered agent transcript, use or improve the native `vitest-evals` Pi harness boundary instead of building a repo-local event log.

## Scope

In scope:

- Multi-turn conversational behavior.
- User-visible response quality and continuity.
- Lifecycle/resilience behavior as observed by users.

## Non-Goals

- Low-level Slack Web API request payload shape assertions.
- Internal implementation details not observable to end users.

## Authoring Rules

1. Define suites via `describeEval()` with the shared Slack harness options, and define cases as plain `it()` tests that call `run(...)` with event builders.
2. Keep each case focused on one primary behavior outcome.
3. Express expectations through the structured rubric shape used by `rubric({ pass, fail })`.
4. Every new or edited eval must keep its rubric human-readable to maintainers.
   The eval test name states the scenario and expected outcome.
   `pass` lists the observable pass conditions.
   `fail` lists failure conditions or forbidden output.
5. Do not write judge criteria as one dense paragraph.
6. Let the `describeEval()` block own the behavior area. The file path and `describeEval()` context already provide scope, so each individual eval name should only state the specific scenario and outcome.
7. Prefer `when <trigger>, <outcome>` over vague labels like `continuity: remembers prior turn context`.
8. Avoid asserting tool-internal mechanics unless explicitly user-visible.
9. Keep user prompts natural and product-realistic. Do not script exact internal commands, tool names, or implementation steps into the prompt just to force a path.
10. If a case only works when the prompt prescribes internal mechanics, treat that as an eval-design failure or product-behavior gap, not a passing eval.
11. If a case uses harness-controlled decision fixtures such as subscribed-message reply gating, do not claim those gated behaviors are being validated by the eval outcome.
12. Put semantic, model-dependent expectations in the rubric; put deterministic boundary expectations in normal Vitest assertions against `result.session`, `toolCalls(result.session)`, or `result.artifacts`.
13. Do not create parallel transcript, event-log, or tool-call schemas for assertions. If the `vitest-evals` primitives cannot express the contract, improve the harness boundary first.

## Boundaries

Do not in eval files:

- Import Slack action internals for direct contract assertions.
- Use MSW queue/capture helpers intended for integration contract tests.
- Rely on implementation-only identifiers (exact internal tool names, opaque IDs) unless the case intentionally evaluates that surface.
- Encode exact internal commands or tool choices in user prompts when the contract under test is higher-level conversational behavior.
- Assert product behavior from logs, spans, or status telemetry. Use session/tool/artifact primitives for behavior contracts; reserve traces/spans for instrumentation tests or diagnostics.

## Relationship to Other Layers

- Integration tests own Slack HTTP contract assertions and most runtime/product wiring.
- Integration tests own real runtime behavior when a deterministic fake agent is sufficient and the contract is not model interpretation itself.
- Unit tests own isolated deterministic logic invariants.
- Evals own agent-facing conversational outcomes across realistic flows and replace ordinary integration tests for that surface.
- Agent-level evals for prompt behavior, skill routing, tool choice, provider/tool calls, and reply quality should use the Pi-agent `vitest-evals` harness boundary when Slack transport is not the behavior under test.
- Slack evals own Slack/runtime behavior: mentions, thread/channel delivery, OAuth privacy, lifecycle/resume behavior, reactions, and Slack-visible side effects.

## When To Choose Evals

Use evals when:

1. The behavior depends on the model interpreting user language correctly.
2. The behavior is about reply quality, continuity, passive participation, or natural-language routing rather than transport wiring.
3. Lower-fidelity integration coverage would only prove a mocked version of the real contract.

Do not choose evals for ordinary Slack payload-shape assertions, deterministic resume wiring, or handler contracts that integration tests can prove directly.

## Execution

Operational commands and harness details live in `packages/junior-evals/README.md`.

The eval session contract should preserve user-visible output structure. In particular, assistant thread posts must retain attachment metadata instead of flattening attachments into synthetic text. Do not collapse the normalized session into prose or synthetic summaries for judge scoring.
