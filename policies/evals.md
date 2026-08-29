# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real runtime.

Suite policy:

- **Integration** (`evals/integration/**`): full-runtime integration coverage
  that must never regress. Failures are hard pass/fail.
- **Behavioral** (domain folders under `evals/` except `integration/`,
  `guardian/`, and `output-router/`): agent behavior with bounded variability.
  CI gates on the aggregate suite floor, not a single weak case.
- **Guardian** (`evals/guardian/**`): isolated action-review snapshots with
  exact `allow` / `ask` / `deny` assertions. Failures are hard pass/fail.
- **Prepare reply** (`evals/output-router/**`): isolated prepare checks over
  one assistant message (`silent` / `reply`). Failures are hard pass/fail.

## Policy

- Keep prompts realistic. Do not script the user request to make the eval pass.
- Assert behavior rules, not incidental wording or execution sequence.
- Put never-break full-runtime integration coverage under `evals/integration/**`.
  Put agent-behavior measurement under behavioral domain folders.
  Put isolated action-review snapshots under `evals/guardian/**`.
  Put isolated prepare-reply cases under `evals/output-router/**`.
- Do not patch product prompts with eval-shaped examples, fixture names, exact
  user messages, expected answers, or distinctive scenario phrases from eval
  files.
- When an eval fails, first state the general product rule the failure exposed.
  Then fix the product invariant, fixture, harness, or implementation at that
  rule level. Do not stack prompt or tool text only to force the case green.
  See `agent-steering.md`.
- Product prompt examples must be neutral examples that are not reused from eval
  scenarios.
- Treat the normalized `vitest-evals` session as the canonical eval surface for
  judges and assertions.
- Limit rubric-judge input to user-visible text from normalized user and
  assistant messages, in session order. Keep tool calls, artifacts, persistence,
  logs, traces, and runtime metadata out of rubric prompts.
- Use rubric judges only for nondeterministic user-visible output. Assert fixed
  tool calls, reactions, attachments, persistence, and delivery side effects
  directly without invoking a judge.
- Keep shared eval assertion helpers small and typed. Prefer selectors over the
  normalized session. Keep `expect` calls at the eval callsite instead of hiding
  multiple assertions behind helpers.
- Use native `vitest-evals` harness support for ordered full-turn transcripts.
  Do not add repo-local event logs or sequencing layers to simulate them.
- Use `toolCalls(result.session)` or other `vitest-evals` primitives when tool
  or provider evidence is part of the behavior.
- Use evals to prove model-facing choices such as whether the agent calls the
  right tool, target, and final-reply strategy. Do not use evals to prove fixed
  tool transport details such as Slack API payload fields or file upload
  serialization. Cover those in integration tests.
- Do not invent parallel transcript, event-log, or tool-call schemas for eval
  assertions. Improve the harness edge instead.
- Keep eval replies within 60 seconds.
- Use fixtures, mocks, or replay for external resources instead of raising
  timeouts.

## Exceptions

- Exact tokens, reply counts, or command details are acceptable only when they
  are the behavior under test.
- Shared vocabulary that is part of the product contract is allowed, but copied
  scenario phrases should be replaced with neutral prompt examples.
