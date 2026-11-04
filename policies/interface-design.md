# Interface Design

## Intent

Interfaces expose the smallest useful capability and keep ownership,
lifecycle, and security edges clear. Module paths, file names, type names, and
function names are part of the interface.

## Policy

### Shape

- Prefer narrow capability methods over dependency bags or access to
  underlying services.
- Expose lifecycle operations such as `dispatch` and `get`, not raw runners,
  clients, routes, or storage adapters.
- Return views (status, ids, summaries), not full internal records.
- Make ownership explicit. A caller reads or changes only records it owns,
  unless cross-owner access is the feature.
- Keep platform details (Slack clients, Vercel primitives, Redis clients,
  model-runtime internals) inside the owning layer.
- Require idempotency keys for APIs that create durable work from retryable
  contexts.
- Keep exported interfaces small and role-shaped.
- Add an interface only when it removes real coupling or marks a stable edge.

### Services

- Passing services as parameters or in an options object is dependency
  injection.
- Keep work data separate from services. Import stable app services from their
  owner. Pass a service only when the caller must choose it (model execution,
  transport, time). Do not thread an app store through callers that do not
  own it.
- Do not use a one-field service options object. Pass the service.
- Do not add a factory, wrapper, alias, or helper that only forwards
  arguments or hides parameter threading. Call the owner directly, unless the
  layer enforces a rule, translates an edge, or owns a lifecycle change.

### Names

- Use short names that state product intent, not implementation mechanics.
- Use one domain noun per concept across types, fields, functions, storage
  keys, and docs. Two names mean two concepts.
- Prefer simple nouns (`Destination`, `Conversation`, `Lease`). Avoid
  `Record`, `State`, `Data`, `Payload`, `Manager`, and `Handler` unless that
  role is the edge.
- Let the module path and parent object carry context: `commitMessages` in
  `state/session-log`, `execution` inside `Conversation`.
- Name files and modules by the concern they own, not the mechanism:
  `state/session-log.ts`, not `state/redis-agent-session-log-store.ts`.
- Name shared indexes, queues, and keys by membership and order
  (`conversation:by-activity`), not by one consumer (`recovery`).
- Optimize for the import site. Add a canonical domain term to a shared export
  only when exact search would mix unrelated concepts. Five qualifiers means
  the module edge does too little.
- Define an overloaded term once in the owning module doc, and do not reuse it
  for nearby concepts.

## Exceptions

- Test fixtures may expose narrow construction seams when the production
  interface stays small.
- Low-level infrastructure may expose mechanism APIs inside its own edge.
- Generic names are fine in a tight module when the import path gives context.
- Compatibility names may stay at external edges or legacy storage keys. New
  internal names use the current domain term.
