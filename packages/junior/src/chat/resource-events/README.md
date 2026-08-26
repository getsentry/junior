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
- Every conversation destination can hold a resource-event watch. Delivery
  wakes that conversation mailbox; the bound destination chooses the worker.
- Plugin-owned routes publish normalized events through the route-hook resource
  event publisher; core binds the plugin namespace and never needs the raw
  provider webhook. Publication requires an active registration that declares
  the event type.
- Plugins declare resource types, supported and suggested event types, optional
  match keys, and whether inbound events are ready on their registration. Core
  builds one enabled runtime catalog for search, tool schemas, and validation.
  Prefer match keys the plugin always sets. If a listed key is missing on an
  event, core does not match.
- `searchResourceEventTypes` discovers that catalog without creating anything.
  `watchResourceEvents` creates a temporary resource subscription for the
  current conversation. Concrete identifiers still come from plugin tool
  results rather than catalog enumeration.
- A temporary watch stores the current conversation id only. It does not store
  destination or rewrite the conversation id.
- Root conversations pin destination on first upsert. That bound destination is
  the safe routing surface for later resource-event wakes.
- Ingestion only wakes that conversation mailbox with plain system input.
  Destination stays on the conversation binding. The worker for the bound
  surface applies it when the turn runs, so the same agent and tools stay active
  for the whole conversation.
- TODO(subagents): destinationless child conversations are not a real bound
  surface yet. When subagents matter, pin watches to the parent root or give
  children the parent's bound destination and worker path.
- Core validates namespace, resource type, and event ownership again before
  storing a subscription.
- Normalized events contain a stable namespace and identifier plus a short safe
  summary. They do not include the raw webhook payload. Plugins may also attach
  small trusted `data` with ids, urls, and other values the agent should not look
  up again. Keep `data` small. Leave deep investigation for tools.
- Ingestion appends a system-authored conversation message and sends a normal
  task-execution wake-up. Resource-event identity constants and detection live
  in `actor.ts` (`RESOURCE_EVENT_SYSTEM_ACTOR`, synthetic author id, and message
  markers). Live and resume paths both execute as that system actor.
- Notification text stays short and uses plain language: what the update is
  about, the instructions for this update, a verified summary and details, and
  external text. When the agent replies, it should summarize what it was acting
  on and what it did or needs next. Stable handling rules live in runtime and
  docs, not a long per-event prompt (`notification.ts`).
- A subscription selector is one conversation, one namespace, one identifier,
  and one or more event types. Optional `match` requires exact trusted values
  from the resource type `matchFields`. Core drops events that do not match
  before any wake. `resourceType` and `label` are display metadata, not match
  keys.
- Duplicate provider deliveries must not create duplicate conversation work.
- A plugin cannot use a resource event to widen conversation visibility or
  credential authority.
- Watches default to 14 days and reject requested lifetimes over 30 days rather
  than silently shortening them.
- Plugins may expose `resourceEvents.subscribe()` so a successful tool can
  create a temporary subscription without asking the model to call
  `watchResourceEvents`. Forced subscriptions should omit those events from the
  tool result's suggested events.
- Resource types may declare optional app guidance per event type. Core inserts
  that text only for the matching resource type. The prompt applies it within
  the subscription intent or stored event task instruction. Keep it separate
  from trusted data and untrusted provider content.

The plugin-facing types and publisher contract live in
`packages/junior-plugin-api/src/resource-events.ts`; subscription storage and
ingestion live in this directory.
