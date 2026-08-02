# Resource Events

Resource subscriptions route plugin-owned events back into an existing
conversation.

## Contract

- Tools may return a subscribable resource hint after a successful plugin
  operation.
- Core owns subscription creation, cancellation, expiry, deduplication, and the
  conversation association.
- Inspection and stop actions stay in the tool catalog. A successful
  subscription result identifies the exact watch id to stop. Omitting that id
  is reserved for an explicit request to stop every watch in the thread.
- A thread opt-out cancels every active subscription for that conversation
  before the Slack thread is marked unsubscribed.
- Plugin route code validates and normalizes incoming events before calling
  the ingestion boundary.
- Plugin-owned routes publish normalized events through the route-hook resource
  event publisher; core binds the plugin namespace and never needs the raw
  provider webhook. Publication requires an active registration that declares
  the event type.
- Plugins declare resource types, supported and suggested event types, and
  ingress readiness on their registration. Core builds one enabled runtime
  catalog for search, tool schemas, and validation.
- `searchResourceEventTypes` discovers that catalog without creating anything.
  `watchResourceEvents` creates a temporary resource subscription for the
  current Slack thread. Concrete identifiers still come from plugin tool
  results rather than catalog enumeration.
- Core validates namespace, resource type, and event ownership again before
  storing a subscription.
- Normalized events contain a stable namespace and identifier plus a bounded,
  safe notification summary rather than a raw webhook payload.
- Ingestion appends a system-authored conversation message and sends a normal
  task-execution wake-up.
- A subscription selector is one namespace, one identifier, and one or more
  event types. `resourceType` and `label` are presentation metadata, not match
  keys.
- Duplicate provider deliveries must not create duplicate conversation work.
- A plugin cannot use a resource event to widen conversation visibility or
  credential authority.
- Watches default to 14 days and reject requested lifetimes over 30 days rather
  than silently shortening them.

The plugin-facing types and publisher contract live in
`packages/junior-plugin-api/src/resource-events.ts`; subscription storage and
ingestion live in this directory.
