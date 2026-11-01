# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real
runtime. Harness mechanics live in `packages/junior-evals/AGENTS.md`.

## Policy

### Suites

- **Integration** (`evals/integration/**`): full-runtime behavior that must
  never regress. Hard pass/fail.
- **Behavioral** (other domain folders under `evals/`): interpretation and
  reply quality. Rubrics allow valid variation, not broken behavior. CI needs
  an 80% case pass rate. A failing case names a product gap.
- **Guardian** (`evals/guardian/**`): exact `allow` / `ask` / `deny`
  decisions. Hard pass/fail.
- **Router** (`evals/router/**`): exact model profile and reasoning level per
  turn. Hard pass/fail.

### Scenarios

- When a judge scores the outcome, inputs and history must show real user
  behavior. Do not script the request to pass.
- When a case only sets up state for a fixed outcome (routing, delivery,
  stored effects), short manufactured inputs are fine. Use few model calls.
- A scenario controls only the agent config, prior turns loaded through the
  runtime's own stores, and mocked third-party APIs. No harness knobs that
  write runtime state, script the model, or replace a Junior-owned module.
- Do not invent transcript, event-log, or tool-call schemas in eval files.
  Fix the fixture or harness.
- Use native `vitest-evals` support for ordered transcripts.
- Keep replies under 60 seconds. Use fixtures, mocks, or replay for external
  resources, not longer timeouts.

### Assertions

- Assert behavior rules, not wording or call order.
- Assert on call results from the agent test fixture: replies, tool calls,
  reactions, and turn states.
- Assert fixed effects (tool calls, reactions, attachments, persistence,
  delivery) directly. Use a rubric judge only for nondeterministic visible
  output.
- Rubric input is only user-visible text from normalized messages, in order.
  No tool calls, artifacts, logs, traces, or metadata.
- Evals prove model choices (tool, target, reply strategy). Slack payload
  fields and upload serialization belong in integration tests.
- Keep shared assertion helpers small and typed. Prefer selectors. Keep
  `expect` at the call site.

### Failures and prompts

- When an eval fails, state the general product rule it exposed, then fix at
  that level. Follow `agent-steering.md`.
- Product prompts must not contain eval fixture names, user messages,
  expected answers, or scenario phrases. Use neutral examples.

## Exceptions

- Exact tokens, reply counts, or commands are fine when they are the behavior
  under test.
- Shared product vocabulary is fine in prompts. Copied scenario phrases are
  not.
- The harness may shorten a product wait (such as the 30 seconds after a
  watched event) when a core test covers the wait. This is the only allowed
  override of a Junior-owned value.
- Global setup may reuse Sandbox snapshot ids from an earlier run.
