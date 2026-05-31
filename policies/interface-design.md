# Interface Design

## Intent

Interfaces should expose the smallest useful capability while keeping ownership, lifecycle, and security boundaries obvious. Module paths, file names, type names, and function names are all part of that interface.

## Policy

- Prefer narrow capability methods over broad dependency bags or access to underlying services.
- Expose lifecycle-oriented operations, such as `dispatch` and `get`, instead of raw runners, clients, routes, or storage adapters.
- Return projections by default. Do not expose full internal records when callers only need status, ids, or summaries.
- Make ownership explicit in the API boundary. A caller should only read or mutate records it owns unless cross-owner access is the feature.
- Keep platform details inside the layer that owns the platform. Do not leak Slack clients, Vercel primitives, Redis clients, or model-runtime internals through feature interfaces.
- Require idempotency keys for APIs that create durable work from retryable contexts.
- Use short JavaScript-facing names for public types and methods. Avoid framework-style names that describe implementation mechanics instead of product intent.
- Spend local context instead of repeating it. A function imported from `state/session-log` can be `commitMessages`; it does not need to be `commitAgentSessionLogMessages`.
- Let folders and file names carry domain context. Prefer `state/session-log.ts` over `state/agent-session-log-store.ts`, and avoid names that repeat parent directories, suffix every file with its technical role, or encode the whole call path.
- Name modules by the concern they own, not by the adapter or mechanism they happen to use. `session-log` is better than `redis-session-log` when Redis is only one backing implementation.
- Keep exported interfaces role-shaped and small. `SessionLogStore` with `read` and `append` is clearer than a broad adapter that exposes unrelated state, Redis, or queue details.
- Prefer import-site readability over globally unique names. If a name is only clear because it includes five qualifiers, the module boundary is probably doing too little work.
- Add an interface only when it removes real coupling or represents a stable boundary.

## Exceptions

- Test fixtures may expose narrower construction seams when the production interface remains small.
- Low-level infrastructure modules may expose mechanism-specific APIs inside their own ownership boundary.
- Generic names are acceptable inside a tightly scoped module when the import path supplies the missing context. Use longer names only when two imported roles would otherwise collide at common call sites.
