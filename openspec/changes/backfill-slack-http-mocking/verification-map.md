# Slack HTTP Mocking Verification Map

| Spec Area                         | Existing Coverage                                | Layer               | Files                                        | Status | Notes                              |
| --------------------------------- | ------------------------------------------------ | ------------------- | -------------------------------------------- | ------ | ---------------------------------- |
| MSW lifecycle                     | global setup/reset/close                         | Test setup          | `tests/msw/setup.ts`                         | keep   | Used by tests and evals.           |
| Unhandled external request policy | strict failure for unmocked HTTP                 | Test setup          | `tests/msw/server.ts`                        | keep   | Allows configured live test hosts. |
| Slack API handlers                | default responses, queues, captures, validation  | Integration support | `handlers/slack-api.ts`                      | keep   | Add methods explicitly.            |
| Slack fixtures                    | deterministic factory payloads                   | Fixtures            | `fixtures/slack/factories/*.ts`              | keep   | Prefer over ad-hoc literals.       |
| Contract tests                    | outbound normalization and Slack payload details | Integration         | `tests/integration/slack/*contract*.test.ts` | keep   | Transport-contract layer.          |
