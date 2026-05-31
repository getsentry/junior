# Integration Testing Backfill Worksheet

## Canonical Spec

- New spec: `integration-testing`

## Local Artifacts Reviewed

- `specs/integration-testing.md`
- `specs/testing.md`
- `packages/junior/tests/integration/**`
- `packages/junior/tests/fixtures/chat-runtime.ts`
- `packages/junior/tests/fixtures/slack-harness.ts`
- `packages/junior/tests/msw/**`
- `packages/junior/scripts/check-slack-test-boundary.mjs`

## External Sources

- Vitest config docs: https://vitest.dev/config/
- MSW Node integration docs: https://mswjs.io/docs/integrations/node
- Slack Web API docs: https://docs.slack.dev/reference/methods/

## Undefined Behavior

| Question                                               | Current Evidence                                   | Candidate Decision                               | Status |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------ | ------ |
| Should boundary checks cover all integration dirs?     | Only Slack behavior root is checked for `vi.mock`. | Extend if violations recur elsewhere.            | open   |
| Should contract tests have required filename suffixes? | Many use `*-contract.test.ts`, but not universal.  | Keep as convention unless enforcement is needed. | open   |
| Should fake-agent seams be centrally enumerated?       | Fixtures expose approved composition seams.        | Document in fixture docs if confusion persists.  | open   |

## Validation

- `openspec validate backfill-integration-testing --strict` passed.
