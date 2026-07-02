# Correctness and Complexity

## Intent

Correct behavior is required, but correctness work should not default to the
most exhaustive design the model can imagine. A change is better only when its
correctness gain is worth the added code, states, callbacks, and maintenance
burden.

## Policy

- Evaluate non-trivial changes on four axes: correctness, simplicity,
  understandability for an average repo developer, and maintainability.
- Prefer the smallest design that closes the proven failure mode. Do not add
  speculative states, abstractions, retries, fallbacks, or recovery paths for
  failures that are not part of the current contract.
- When correctness requires complexity, name the invariant at the owning
  boundary and keep the implementation local to that boundary.
- Avoid spreading one invariant across callbacks in multiple layers. If several
  layers must participate, one layer should own the lifecycle transition and the
  others should expose narrow capabilities.
- Do not hide complexity behind best-effort logging, ambient context, or
  one-hop wrappers. If a future developer must know about the hidden state to
  change behavior safely, the design is not simple.
- A review that finds "more correct but harder to understand" should require a
  simplification pass before merge unless the risk is urgent and documented.
- Tests should prove the invariant at the highest useful boundary, not encode
  every internal step of a complex implementation.

## Exceptions

- Security, privacy, data-loss, and duplicate-side-effect fixes may temporarily
  increase complexity when a smaller safe design is not available in the same
  change.
- Temporary complexity must be explicit in the PR description or follow-up
  issue, including which invariant it protects and what simplification remains.
