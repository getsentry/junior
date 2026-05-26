# Interface Design

## Intent

Interfaces should expose the smallest useful capability while keeping ownership, lifecycle, and security boundaries obvious.

## Policy

- Prefer narrow capability methods over broad dependency bags or access to underlying services.
- Expose lifecycle-oriented operations, such as `dispatch` and `get`, instead of raw runners, clients, routes, or storage adapters.
- Return projections by default. Do not expose full internal records when callers only need status, ids, or summaries.
- Make ownership explicit in the API boundary. A caller should only read or mutate records it owns unless cross-owner access is the feature.
- Keep platform details inside the layer that owns the platform. Do not leak Slack clients, Vercel primitives, Redis clients, or model-runtime internals through feature interfaces.
- Require idempotency keys for APIs that create durable work from retryable contexts.
- Use short JavaScript-facing names for public types and methods. Avoid framework-style names that describe implementation mechanics instead of product intent.
- Add an interface only when it removes real coupling or represents a stable boundary.

## Exceptions

- Test fixtures may expose narrower construction seams when the production interface remains small.
- Low-level infrastructure modules may expose mechanism-specific APIs inside their own ownership boundary.
