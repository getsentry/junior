# Context-Bound Systems

## Intent

Runtime behavior should receive the authority, destination, and scope it needs
as explicit context. Junior must not guess who is acting, where side effects
belong, or which credentials apply from nearby metadata after work crosses an
async, durable, or platform edge.

## Policy

- APIs that cross ingress, queue, callback, plugin, sandbox, scheduler, or
  durable-state edges must carry the identity context the next step needs:
  current actor, destination, optional credential subject, and correlation ids.
- Shared context contracts that cross plugin, scheduler, dispatch, or
  durable-state edges must follow `./runtime-boundary-schemas.md`.
- Keep the current actor separate from author history, creator metadata,
  service-principal credentials, destination membership, actor-sensitive
  credential subjects, and display names.
- Validate untrusted platform or plugin payloads at the edge that receives them.
  After Junior signs, stores, or dispatches context it owns, later code must
  assert that context exactly. Do not normalize or repair it on read.
- Missing required context is an error, blocked state, or rejected input. Do not
  guess from prior messages, Slack channel membership, task creators, profile
  names, or synthetic sentinel values.
- Tool and model inputs must not supply privileged runtime context when the
  runtime can derive it from the active conversation, actor, destination, or
  artifact state.
- Display labels are presentation data. They may be cleaned for UX, but they
  must not become an identity source or overwrite actor ids.
- Retryable and resumable workflows must keep the same identity context and
  idempotency context across retries and continuation slices.
- In-memory values are caches only. Any value that must be used after a tool
  edge, async edge, resume, delivery edge, or later turn must have a stored
  handle before success is reported. A handle may point at bounded short-lived
  storage only when the lifecycle accepts disappearance as a recoverable
  failure.

## Exceptions

- Platform adapters may parse external payloads into exact internal identifiers
  at ingress.
- One-time migrations may repair old malformed state. The migration must be
  named, bounded, and verified separately from normal runtime reads.
