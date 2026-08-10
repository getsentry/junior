# Serverless Background Work

## Intent

Background work must survive serverless request edges, retries, and process loss
without relying on memory or long-lived workers.

## Policy

- Store durable work state before starting background execution.
- Internal callbacks should carry only small signed envelopes, such as ids and
  expected versions. Store full work payloads in durable state.
- Treat `waitUntil` as a per-request lifetime extension, not a job system.
- Make background work idempotent and retryable.
- Split long work into bounded slices with max attempts, max age, and max
  continuation depth.
- Define explicit recovery for stale non-terminal states such as `pending`,
  `running`, and `awaiting_resume`.
- Use durable leases or locks for ownership. Define lock ordering when work
  touches multiple state domains.
- Do not expose platform-specific background primitives directly to feature code
  or plugins unless that platform is the feature edge.
- Stored user-authored instructions remain user content even when a system actor
  runs them later.

## Exceptions

- Purely best-effort telemetry or cache warming may skip durable state when
  losing the work has no product effect.
- Local development helpers may use in-memory execution when production code
  still follows the durable path.
