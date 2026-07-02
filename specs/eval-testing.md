# Eval Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-07-02

## Purpose

Evals cover agent-facing behavior through the runtime harness when the contract
depends on model interpretation. Layer-selection judgment lives in
`../policies/testing.md`.

## Use For

- Natural-language routing and intent handling.
- Reply quality and continuity.
- Prompt, skill, tool-choice, and provider behavior.
- User-visible multi-turn outcomes.

## Mechanics

- Define suites with `describeEval()`.
- Define cases as normal `it()` tests that call `run(...)`.
- Use realistic prompts; do not script internal tool names or implementation
  steps into the user request.
- Put semantic expectations in `rubric({ pass, fail })`.
- Put deterministic boundary assertions against `result.session`,
  `toolCalls(result.session)`, artifacts, or traces.
- Run focused files with:
  `pnpm --filter @sentry/junior-evals evals path/to/eval.eval.ts`

## Assertion Surface

The normalized `vitest-evals` session is canonical. Do not create repo-local
transcript, event-log, or tool-call schemas when the harness surface can be
improved instead.

## Do Not Use For

- Slack payload-shape assertions.
- Deterministic resume or handler wiring that integration tests can prove.
- Product behavior from logs, spans, or status telemetry.
