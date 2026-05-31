# Design: Eval Testing Baseline

## Sources Reviewed

- `specs/eval-testing.md`
- `specs/testing.md`
- `policies/evals.md`
- `packages/junior-evals/README.md`
- `packages/junior-evals/package.json`
- `packages/junior-evals/vitest.evals.config.ts`
- `packages/junior-evals/evals/helpers.ts`
- `packages/junior-evals/evals/behavior-harness.ts`
- representative eval suites under `packages/junior-evals/evals/core`, `github`, and `sentry`

External primary sources reviewed:

- Vitest config docs for test include, timeout, setup files, and single-worker execution.
- Vercel AI Gateway docs for model/provider-backed execution.
- MSW Node docs because eval harness still uses shared MSW setup for controlled HTTP behavior.

## Current Pattern

Evals use:

- `describeEval()` and `slackEvals`;
- realistic Slack event builders (`mention`, `threadMessage`, `threadStart`);
- `rubric({ contract, pass, allow, fail })`;
- memory state and replay mode by default;
- real runtime/harness flow with model-backed judging;
- selected overrides for credentials, auth completion, image generation, reply failures, and subscribed-message gate fixtures.

## Undefined Behavior

- Some eval files are named by historical suite rather than capability requirement.
- Some cases may assert implementation evidence where user-visible behavior would be better.
- Credential and sandbox bootstrap failures can block local runs; the harness has explicit error messages, but the repo cannot guarantee local credentials.
- Eval run cost and flake budget are not yet separately specified.

## Verification Strategy

- Focused eval command: `pnpm --filter @sentry/junior-evals evals path/to/eval.test.ts` or equivalent Vitest filter.
- Full eval suite: `pnpm evals`, when credentials and sandbox access are available.
- Boundary script runs before evals.
- Eval taxonomy migration map owns case-by-case keep/rename/split decisions.
