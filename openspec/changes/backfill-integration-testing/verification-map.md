# Integration Testing Verification Map

| Spec Area                 | Existing Coverage                                               | Layer       | Files                                                       | Status  | Notes                                     |
| ------------------------- | --------------------------------------------------------------- | ----------- | ----------------------------------------------------------- | ------- | ----------------------------------------- |
| Runtime behavior          | Slack mention/subscribed/lifecycle flows                        | Integration | `packages/junior/tests/integration/slack/*behavior.test.ts` | keep    | Fake agent only at boundary.              |
| Slack transport contracts | request payloads, outbound normalization, status/auth contracts | Integration | `packages/junior/tests/integration/slack/*contract.test.ts` | keep    | Details split to Slack HTTP mocking spec. |
| Cross-module workflows    | auth resume, MCP, scheduler, dispatch, sandbox                  | Integration | `packages/junior/tests/integration/*.test.ts`               | keep    | Default for deterministic product wiring. |
| Boundary enforcement      | no runtime mocks in Slack behavior root                         | Script      | `check-slack-test-boundary.mjs`                             | partial | Not exhaustive.                           |
| Focused verification      | single-file Vitest command                                      | Command     | AGENTS.md file-scoped command                               | keep    | Use for changed integration files.        |
