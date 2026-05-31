# Eval Testing Verification Map

| Spec Area                | Existing Coverage                          | Layer        | Files                           | Status  | Notes                                    |
| ------------------------ | ------------------------------------------ | ------------ | ------------------------------- | ------- | ---------------------------------------- |
| Eval runner config       | node, serial, timeout, MSW setup, reporter | Config       | `vitest.evals.config.ts`        | keep    | Requires Gateway/Sandbox access.         |
| Eval authoring helpers   | event builders, rubric formatter, judge    | Eval harness | `evals/helpers.ts`              | keep    | Contract for rubric shape.               |
| Harness execution        | real runtime/harness, overrides, replay    | Eval harness | `evals/behavior-harness.ts`     | keep    | Details may split by harness spec later. |
| Boundary enforcement     | no Slack contract internals in evals       | Script       | `check-slack-test-boundary.mjs` | keep    | Runs before evals.                       |
| Existing behavior suites | core and plugin evals                      | Eval         | `evals/**/*.eval.ts`            | migrate | Task 7.6 maps keep/rename/split.         |
