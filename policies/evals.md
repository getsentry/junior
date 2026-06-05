# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real runtime.

## Policy

- Keep prompts realistic; do not script the user request to make the eval pass.
- Assert behavior invariants, not incidental wording or execution sequence.
- Use tool/provider evidence when that boundary is part of the behavior.
- Prefer adding expectations to an existing realistic eval when it already exercises
  the behavior; add a new case only for a distinct journey or failure mode.
- Use structured harness output for stable runtime metadata, not logs, spans,
  prompt text, or incidental internals.
- Do not use canned assistant reply/result fixtures to validate prompt,
  model-routing, thinking-level, or other real generation behavior.
- Keep eval cases within 30 seconds.
- Use fixtures, mocks, or replay for external resources instead of raising timeouts.

## Exceptions

- Exact tokens, reply counts, or command details are acceptable only when they are the behavior under test.
