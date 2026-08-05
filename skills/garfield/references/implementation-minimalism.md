# Implementation Minimalism Policy

## Intent

Implementation slices should solve the requested problem without accumulating speculative guardrails, fallbacks, abstractions, or tests for unlikely states. Defensive code is useful at real boundaries; inside established invariants it often hides defects by converting failures into plausible success.

## Policy

- Implement the smallest clear behavior that satisfies the user goal, existing contract, and validation evidence.
- Do not add defensive checks, broad catches, fallback/default values, retries, compatibility shims, abstractions, or normalization for hypothetical states.
- Trust an established type, validated input, lock, query, or ownership boundary only when the code can identify what establishes the invariant and how long it remains valid.
- Do not turn missing required data, invariant violations, or unexpected failures into empty, default, stale, or otherwise successful results unless the contract requires that fallback.
- Remove current-diff guards and adapters that duplicate upstream validation, are unreachable, or only support imagined callers or states.
- Do not add tests solely to justify speculative guardrails. Tests should prove requested behavior, existing contracts, real regressions, or realistic boundary failures.

## Exceptions

- Validate untrusted input and external-system output at the earliest practical trust boundary; avoid repeating the same validation downstream.
- Preserve checks required by the user goal, product spec, public API, permission or security boundary, idempotency contract, lock order, durable integrity rule, migration compatibility, or a concrete regression. Do not remove one merely because current repository callers or writers appear to make it redundant.
- A cheap local assertion is appropriate when it makes a critical invariant fail visibly. At security, transaction, and persistence boundaries, prefer a named assertion or explicit error over a non-null assertion.
