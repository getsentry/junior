# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real runtime.

## Policy

- Keep prompts realistic; do not script the user request to make the eval pass.
- Assert behavior invariants, not incidental wording or execution sequence.
- Do not patch product prompts with eval-shaped examples, fixture names, exact user messages, expected answers, or distinctive scenario phrases from eval files.
- When an eval fails, first state the general product invariant the failure exposed, then fix the product prompt or implementation at that invariant level.
- Product prompt examples must be neutral examples that are not reused from eval scenarios.
- Treat the normalized `vitest-evals` session as the canonical eval surface for judges and assertions.
- Limit rubric-judge input to user-visible text from normalized user and assistant messages, in session order. Keep tool calls, artifacts, persistence, logs, traces, and runtime metadata out of rubric prompts.
- Use native `vitest-evals` harness support for ordered full-turn transcripts; do not add repo-local event logs or sequencing layers to simulate them.
- Use `toolCalls(result.session)` or other `vitest-evals` primitives when tool/provider evidence is part of the behavior.
- Use evals to prove model-facing choices such as whether the agent calls the
  right tool, target, and final-reply strategy. Do not use evals to prove
  deterministic tool transport details such as Slack API payload fields or file
  upload serialization; cover those in integration tests.
- Do not invent parallel transcript, event-log, or tool-call schemas for eval assertions; improve the harness boundary instead.
- Keep eval cases within 30 seconds.
- Use fixtures, mocks, or replay for external resources instead of raising timeouts.

## Exceptions

- Exact tokens, reply counts, or command details are acceptable only when they are the behavior under test.
- Shared vocabulary that is part of the product contract is allowed, but copied scenario phrases should be replaced with neutral prompt examples.
