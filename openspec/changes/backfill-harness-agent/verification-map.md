# Verification Map: `harness-agent`

| Capability      | Requirement             | Scenario                             | Primary Layer    | Current Coverage                                              | Action   | Gap                                                   | Notes                                   |
| --------------- | ----------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------- | -------- | ----------------------------------------------------- | --------------------------------------- |
| `harness-agent` | Pi turn execution       | Fresh turn uses prompt               | unit             | `respond-lazy-sandbox.test.ts`, other respond tests           | keep     | None known                                            | Mocked Pi is appropriate.               |
| `harness-agent` | Pi turn execution       | Resumed turn uses continue           | unit/integration | `respond-timeout-resume.test.ts`, `turn-resume-slack.test.ts` | keep     | None known                                            | Cross-link session spec.                |
| `harness-agent` | Pi turn execution       | Current prompt only                  | integration      | `message-content-behavior.test.ts`                            | keep     | None known                                            | Prompt capability owns context details. |
| `harness-agent` | Thinking-level routing  | Classifier success                   | unit             | `turn-thinking-level.test.ts`                                 | keep     | None known                                            | Could be separate capability later.     |
| `harness-agent` | Thinking-level routing  | Fallback/default                     | unit             | `turn-thinking-level.test.ts`                                 | keep     | None known                                            | Important.                              |
| `harness-agent` | Thinking-level routing  | Context floor                        | unit             | `turn-thinking-level.test.ts`                                 | keep     | None known                                            | Verify specific coverage later.         |
| `harness-agent` | Final output resolution | Ignore pre-tool assistant text       | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Final output resolution | Use terminal assistant text          | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Final output resolution | Empty output failure                 | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Final output resolution | Raw payload/escape failure           | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Final output resolution | Side-effect-only success             | unit/integration | `turn-result.test.ts`, Slack side-effect tests                | keep     | Ownership open.                                       | May move to reply-planning later.       |
| `harness-agent` | Streaming callbacks     | Text delta forwarded                 | integration/unit | `finalized-reply-behavior.test.ts`, `bot-handlers.test.ts`    | keep     | Need direct callback failure case if absent.          | Delivery ignores provisional text.      |
| `harness-agent` | Streaming callbacks     | Separator between assistant messages | unit             | Existing coverage unclear                                     | add      | Open exact behavior.                                  | Decide before adding.                   |
| `harness-agent` | Streaming callbacks     | Callback failure logged/non-fatal    | unit             | Existing coverage unclear                                     | add      | Need focused test if desired.                         | Not user-visible today.                 |
| `harness-agent` | Timeout handling        | Abort and settle                     | unit             | `respond-timeout-resume.test.ts`                              | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Timeout handling        | Retryable metadata                   | unit             | `respond-timeout-resume.test.ts`                              | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Timeout handling        | Provider-error fallback              | unit             | Existing coverage unclear                                     | add      | Need no-session/no-boundary fallback check if absent. | Cross-link session spec.                |
| `harness-agent` | Provider retry          | Retry transient error                | unit             | `respond-provider-retry.test.ts`                              | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Provider retry          | Cumulative usage                     | unit             | `respond-provider-retry.test.ts`                              | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Provider retry          | Unsafe boundary/limit                | unit             | `respond-provider-retry.test.ts`                              | keep/add | Confirm exact coverage.                               | Add if missing.                         |
| `harness-agent` | Harness diagnostics     | Success diagnostics                  | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Harness diagnostics     | Provider error diagnostics           | unit             | `turn-result.test.ts`, `respond-error-path.test.ts`           | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Harness diagnostics     | Execution failure diagnostics        | unit             | `turn-result.test.ts`                                         | keep     | None known                                            | Strong.                                 |
| `harness-agent` | Verification taxonomy   | Output mechanics unit                | manual           | This map                                                      | keep     | None                                                  | Taxonomy artifact.                      |
| `harness-agent` | Verification taxonomy   | Pi loop unit/integration             | manual           | This map                                                      | keep     | None                                                  | Taxonomy artifact.                      |
| `harness-agent` | Verification taxonomy   | Answer quality eval                  | eval/manual      | Existing evals                                                | split    | Need eval taxonomy pass.                              | Not harness mechanics.                  |

## Layer Rules

- Use `unit` for output extraction, diagnostics, thinking routing, provider retry, timeout metadata, and callback mechanics.
- Use `integration` for runtime wiring across Slack/session/tool contexts.
- Use `eval` for final answer quality and prompt-following, not deterministic harness mechanics.

## Coverage Action Meanings

- `keep`: Current test/eval covers the scenario with the right scope and name.
- `rename`: Coverage is right, but taxonomy/name is misleading.
- `split`: File or case mixes multiple capabilities and should be separated.
- `move`: Coverage belongs in a different layer or package.
- `replace`: Existing coverage is low-fidelity or asserts the wrong contract.
- `delete`: Existing coverage duplicates another stronger check or asserts non-contract internals.
- `add`: No current coverage exists.
