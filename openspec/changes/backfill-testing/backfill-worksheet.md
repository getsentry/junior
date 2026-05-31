# Testing Backfill Worksheet

## Canonical Spec

- New spec: `testing`

## Local Artifacts Reviewed

- `specs/testing.md`
- `specs/unit-testing.md`
- `specs/integration-testing.md`
- `specs/eval-testing.md`
- `specs/slack-http-mocking.md`
- `packages/junior/vitest.config.ts`
- `packages/junior/package.json`
- `packages/junior/scripts/check-slack-test-boundary.mjs`
- `packages/junior/tests/unit/**`
- `packages/junior/tests/integration/**`
- `packages/junior/tests/msw/**`
- `packages/junior/tests/fixtures/slack/**`
- `packages/junior-evals/package.json`
- `packages/junior-evals/README.md`
- `packages/junior-evals/vitest*.config.ts`
- `packages/junior-evals/evals/**`
- `policies/evals.md`

## External Sources

- Vitest config docs: https://vitest.dev/config/
- Vitest mocking docs: https://vitest.dev/guide/mocking.html
- Vitest setup files docs: https://vitest.dev/config/#setupfiles
- MSW Node integration docs: https://mswjs.io/docs/integrations/node
- Vercel AI Gateway models/providers docs: https://vercel.com/docs/ai-gateway/models-and-providers

## Current Behavior Summary

- Testing taxonomy is documented in prose specs.
- `@sentry/junior` test suite runs Vitest in node environment with MSW setup.
- Unit/integration/eval are separated by path and package.
- Integration tests should use real runtime paths with fake agent boundary only.
- Evals use separate package scripts and judge-scored conversational criteria.
- Boundary script blocks selected low-fidelity patterns.

## Undefined Behavior

| Question                                         | Current Evidence                                                       | Candidate Decision                                                        | Status |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| Should legacy broad unit tests be moved?         | Some unit tests cover runtime seams.                                   | Move only when touching behavior or when a spec backfill identifies risk. | open   |
| Should boundary enforcement cover more patterns? | Current script checks selected Slack/eval patterns.                    | Extend only for repeated violations.                                      | open   |
| Should all eval files be renamed by capability?  | Existing names are partly historical.                                  | Use task 7.6 migration map first.                                         | open   |
| What is the default full verification command?   | Commands vary by surface; full evals can require external credentials. | Keep per-spec verification maps instead of one universal command.         | open   |

## Validation

- `openspec validate backfill-testing --strict` passed.
