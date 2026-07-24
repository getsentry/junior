# Resource Events

Resource subscriptions route provider-owned events back into an existing
conversation.

## Contract

- Tools may return a subscribable resource hint after a successful provider
  operation.
- Core owns subscription creation, cancellation, expiry, deduplication, and the
  conversation association.
- Inspection and stop actions stay in the tool catalog. A successful
  subscription result identifies the exact no-argument catalog call that stops
  every resource watch for the conversation.
- A thread opt-out cancels every active subscription for that conversation
  before the Slack thread is marked unsubscribed.
- Provider route code validates and normalizes incoming events before calling
  the ingestion boundary.
- Plugin-owned provider routes publish normalized events through the route-hook
  resource event publisher; core never needs the raw provider webhook.
- Normalized events contain stable provider/resource identity and a bounded,
  safe notification summary rather than a raw webhook payload.
- Ingestion appends a system-authored conversation message and sends a normal
  task-execution wake-up.
- Duplicate provider deliveries must not create duplicate conversation work.
- A plugin cannot use a resource event to widen conversation visibility or
  credential authority.

The plugin-facing types and publisher contract live in
`packages/junior-plugin-api/src/resource-events.ts`; subscription storage and
ingestion live in this directory.
