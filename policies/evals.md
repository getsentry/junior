# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real runtime.

## Policy

- Keep prompts realistic; do not script the user request to make the eval pass.
- Assert behavior invariants, not incidental wording or execution sequence.
- Treat the normalized `vitest-evals` session as the canonical eval surface for judges and assertions.
- Use native `vitest-evals` harness support for ordered full-turn transcripts; do not add repo-local event logs or sequencing layers to simulate them.
- Use `toolCalls(result.session)` or other `vitest-evals` primitives when tool/provider evidence is part of the behavior.
- Do not invent parallel transcript, event-log, or tool-call schemas for eval assertions; improve the harness boundary instead.
- Keep eval cases within 30 seconds.
- Use fixtures, mocks, or replay for external resources instead of raising timeouts.

## Exceptions

- Exact tokens, reply counts, or command details are acceptable only when they are the behavior under test.
