# Interface Design Policy

## Intent

Interfaces should expose the smallest useful capability while keeping ownership, lifecycle, security, and coupling boundaries obvious.

## Policy

- Report only material interface defects: unclear ownership, incomplete lifecycle, security exposure, unstable coupling, or a contract that permits realistic caller misuse. Do not flag naming or shape preferences without one of those consequences.
- Prefer narrow capability methods over broad dependency bags or access to underlying services.
- Expose lifecycle-oriented operations, such as `dispatch` and `get`, instead of raw runners, clients, routes, or storage adapters.
- Return projections by default. Do not expose full internal records when callers only need status, ids, or summaries.
- Make ownership explicit in the API boundary. A caller should only read or mutate records it owns unless cross-owner access is the feature.
- Keep platform details inside the layer that owns the platform. Do not leak Slack clients, Vercel primitives, Redis clients, or model-runtime internals through feature interfaces.
- Require idempotency keys for APIs that create durable work from retryable contexts.
- Use one domain noun for one concept across types, fields, functions, storage keys, and docs. Spend module and parent-object context instead of repeating technical role or call-path qualifiers.
- Name modules and durable keys by the domain concern or data contract they own, not an incidental adapter, mechanism, or current consumer.
- Keep exported interfaces role-shaped and small. `SessionLogStore` with `read` and `append` is clearer than a broad adapter that exposes unrelated state, Redis, or queue details.
- When a term is overloaded in the product or platform, define it once in the owning spec and avoid using it for nearby concepts.
- Add an interface, wrapper, or dependency parameter only when it removes real coupling or represents a stable boundary. Narrow dependency injection is healthy for an external or platform capability; a production seam used only to unit-test a local helper is not.
- Prefer the real SDK surface, a protocol boundary, or an existing narrow adapter in tests. Do not default to whole-module mocks to avoid designing a healthy boundary.
- Flag only new or changed boundaries, or names made misleading by this slice. Defer naming-only concerns unless they obscure ownership, lifecycle, security, or call-site meaning.
- Keep this lane to interface defects. Leave missing tests, comments, validation commands, and bookkeeping to their owning review tasks unless they directly prove the interface is misleading or unsafe.

## Exceptions

- Test fixtures may expose narrower construction seams when the production interface remains small.
- Low-level infrastructure modules may expose mechanism-specific APIs inside their own ownership boundary.
- Generic names are acceptable inside a tightly scoped module when the import path supplies the missing context. Use longer names only when two imported roles would otherwise collide at common call sites.
- Compatibility names may remain at external boundaries or legacy storage keys. New internal names should still normalize to the current domain term.
