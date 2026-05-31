# Slack HTTP Mocking Backfill Worksheet

## Canonical Spec

- New spec: `slack-http-mocking`

## Local Artifacts Reviewed

- `specs/slack-http-mocking.md`
- `packages/junior/tests/msw/setup.ts`
- `packages/junior/tests/msw/server.ts`
- `packages/junior/tests/msw/handlers/slack-api.ts`
- `packages/junior/tests/msw/handlers/slack-webhooks.ts`
- `packages/junior/tests/fixtures/slack/factories/*.ts`
- `packages/junior/tests/integration/slack/*contract*.test.ts`

## External Sources

- MSW Node integration docs: https://mswjs.io/docs/integrations/node
- Slack Web API docs: https://docs.slack.dev/reference/methods/
- Vitest setup files docs: https://vitest.dev/config/#setupfiles

## Undefined Behavior

| Question                                               | Current Evidence                            | Candidate Decision                                   | Status |
| ------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- | ------ |
| Should provider HTTP mocks split from Slack MSW setup? | Eval OAuth/MCP/GitHub handlers share setup. | Keep one setup; keep specs scoped by handler family. | open   |
| Should unsupported Slack methods fail by default?      | Supported method list is explicit.          | Yes; add method only with tests.                     | open   |
| Should captured request order be asserted broadly?     | Capture arrays preserve order.              | Assert order only when contract-relevant.            | open   |

## Validation

- `openspec validate backfill-slack-http-mocking --strict` passed.
