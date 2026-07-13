# Resource Events

Resource subscriptions route provider-owned events back into an existing
conversation.

## Contract

- Tools may return a subscribable resource hint after a successful provider
  operation.
- Core owns subscription creation, cancellation, expiry, deduplication, and the
  conversation association.
- Provider route code validates and normalizes incoming events before calling
  the ingestion boundary.
- Normalized events contain stable provider/resource identity and a bounded,
  safe notification summary rather than a raw webhook payload.
- Ingestion appends a system-authored conversation message and sends a normal
  task-execution wake-up.
- Duplicate provider deliveries must not create duplicate conversation work.
- A plugin cannot use a resource event to widen conversation visibility or
  credential authority.

The plugin-facing types live in
`packages/junior-plugin-api/src/resource-events.ts`; storage and ingestion live
in this directory.
