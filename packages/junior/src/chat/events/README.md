# Events

Watches route events back into an existing conversation.

## Contract

- Tools may return a subscribable resource hint after a successful plugin
  operation.
- Core owns subscription creation, cancellation, expiry, deduplication, and the
  conversation association.
- Inspection and stop actions stay in the tool catalog. A successful
  watch result identifies the exact watch id to stop. Omitting that id
  is reserved for an explicit request to stop every watch in the thread.
- A thread opt-out cancels every active subscription for that conversation
  before the Slack thread is marked unsubscribed.
- Plugin route code validates and normalizes incoming events before calling
  the ingestion boundary.
- Every conversation can hold a watch. A matching event wakes
  that conversation mailbox; the conversation destination chooses the worker.
- Plugin-owned routes publish normalized events through the route-hook resource
  event publisher; core binds the plugin namespace and never needs the raw
  provider webhook. Publication requires an active registration that declares
  the event type.
- Plugins declare resource types, supported and suggested event types, optional
  match keys, and whether inbound events are ready on their registration. Core
  builds one enabled runtime catalog for search, tool schemas, and validation,
  including core Workspace snapshot events. Prefer match keys the publisher
  always sets. If a listed key is missing on an event, core does not match.
- Core also registers the `junior` / `workspace_snapshot` resource type for
  snapshot ready and failed events. That namespace is reserved; plugins must not
  claim it. Temporary watches created by `switchWorkspace` use the same catalog
  entry and event guidance as any other watch.
- `searchEventTypes` discovers that catalog without creating anything.
  `watchEvents` creates a temporary watch for the
  current conversation. Concrete identifiers still come from plugin tool
  results rather than catalog enumeration.
- A temporary watch stores the current conversation id only. It does not store
  destination or rewrite the conversation id.
- Root conversations set destination on first upsert. Later event wakes
  use that destination.
- Ingestion only wakes that Conversation mailbox with plain system input. The
  input contains text and event metadata. Destination and Location stay on the
  Conversation. The shared mailbox worker runs a normal Turn. Slack supplies
  Delivery for the Location. It does not build webhook Message or Thread objects.
- TODO(subagents): child conversations still store watches on their own id.
  When subagents matter, store the parent root id or give children the parent's
  destination and worker path.
- Core validates namespace, resource type, and event ownership again before
  storing a subscription.
- Normalized events contain a stable namespace and identifier plus a short safe
  summary. They do not include the raw webhook payload. Plugins may also attach
  small trusted `data` with ids, urls, and other values the agent should not look
  up again. Keep `data` small. Leave deep investigation for tools.
- Ingestion appends a system-authored conversation message and sends a normal
  task-execution wake-up. Resource-event identity constants and detection live
  in `actor.ts` (`EVENT_SYSTEM_ACTOR`, synthetic author id, and message
  markers). The mailbox worker builds an Event Source from the stored
  event identity. The Turn stores that Source, and resume restores it. Live and
  resume paths both execute as the system actor.
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
- A conversation may run only a bounded streak of consecutive automated turns.
  After that limit, later event wakes stay quiet until a user message
  clears the pause. The Turn that hits the limit posts a plain notice in the
  thread. Terminal watches can still complete after a refused wake.
- A plugin cannot use an event to widen conversation visibility or
  credential authority.
- Watches default to 14 days and reject requested lifetimes over 30 days rather
  than silently shortening them.
- Plugins may expose `events.subscribe()` so a successful tool can create a
  watch without asking the model to call
  `watchEvents`. Forced subscriptions should omit those events from the
  tool result's suggested events.
- Resource types may declare optional app guidance per event type. Core inserts
  that text only for the matching resource type. The prompt applies it within
  the subscription intent or stored event automation instruction. Keep it separate
  from trusted data and untrusted provider content.

## Timer Watches

`watchTimer({ afterMs, intent })` returns a Watch id and `firesAtMs`. It stores
one temporary Watch in the current Conversation. It does not hold a process or
Sandbox open. Use an Event Watch when the required Event is available.

- Delays must be positive integers and cannot exceed 29 days. The Watch expires
  24 hours after its deadline, within the existing 30-day limit.
- The Conversation and tool-call id determine the timer id. Replaying a call
  returns its stored deadline without resetting an active or terminal Watch.
  This protection lasts while the Watch record is retained.
- `timer-index.ts` owns the Redis sorted set of pending timer ids. The score is
  the next eligible dispatch time. Heartbeat claims at most 25 ids and moves
  their scores forward by two minutes. No scan of all Watches is needed.
- Registration writes indexes before the record while holding the Watch and
  Conversation index locks. A crash can leave a missing record in the due
  index, but cannot leave a saved timer outside that index. Heartbeat checks
  the record under the same Watch lock before removing a stale entry.
- `timers.ts` publishes a terminal `junior / timer.fired` Event with a stable
  Event key. Existing ingestion owns mailbox delivery and duplicate suppression.
  A failed dispatch remains eligible after the claim expires.
- Timers keep normal Event batching and run as the system Actor. They do not
  retain the creator's credentials. The minute heartbeat, Event batching,
  queue load, and active Turns can delay execution beyond the deadline.
- Existing list, stop, and thread opt-out actions cover timers. Cancellation
  before delivery prevents input. It cannot recall input already delivered.
- Heartbeat removes missing, expired, or terminal entries from the due index.
  Expired timers do not start a Turn. Automated-turn limits still apply.

There is no recurrence, reset API, separate Automation, or delayed timer queue.

The plugin-facing types and publisher contract live in
`packages/junior-plugin-api/src/events.ts`. Watch storage and ingestion live in
this directory.
