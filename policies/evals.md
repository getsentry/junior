# Evals

## Intent

Evals are integration tests for agent-facing behavior through the real runtime.

## Policy

- Keep prompts realistic; do not script the user request to make the eval pass.
- Assert behavior invariants, not incidental wording or execution sequence.
- Use tool/provider evidence when that boundary is part of the behavior.
- Keep eval cases within 30 seconds.
- Use fixtures, mocks, or replay for external resources instead of raising timeouts.

## Exceptions

- Exact tokens, reply counts, or command details are acceptable only when they are the behavior under test.
