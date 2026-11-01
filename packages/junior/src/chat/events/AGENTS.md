# Events

This module owns Watches, Event ingestion, timer Watches, and the runtime Event
catalog. Matching Events wake an existing Conversation. Plugin-facing types
and the publisher contract are in `packages/junior-plugin-api/src/events.ts`.

## Owns / does not own

- Core owns Watch creation, cancellation, expiry, deduplication, and the
  Conversation association.
- Plugins own webhook routes, validation, and normalization. Core never reads
  the raw provider webhook.
- Watch ownership across the agent tree is in `owned-watches.ts`. A child never
  sees or stops a Watch of its parent or a sibling.
- Task input layout is in `../task-input.ts`. Event automations are in
  `../event-automations/`.

## Catalog

- `getEventCatalog` builds one enabled catalog for search, tool schemas, and
  validation. Core reserves the `junior` and `slack` namespaces. It throws when
  a plugin claims one.
- `EventResourceTypeLimits` in `catalog.ts` are core-only. Do not add them to
  the plugin API or API responses.
- `eventTriggerProblems` in the plugin API is the only trigger check. Core,
  tools, and the dashboard all use it. Do not copy its rules.
- Every event type declares its Event reach once in `events`. A trigger with
  no identifier can select only `"all"` or `{ anyOf }` events and must set an
  `anyOf` filter.
- Use reach `"all"` only for status facts with no side effects. Use
  `{ anyOf }` or `"resource"` when an Event carries private text or makes
  Junior act.

## Publishing rules

- Publication needs an active registration that declares the event type.
- `eventKey` names one provider change. A retry of the same delivery and every
  copy sent to several identifiers use the same key and `data`.
- Set `terminal` only on the copy for the exact resource, and only when the
  change ends it.
- Normalized Events never contain the raw webhook payload. Keep `data` small
  and trusted.
- Prefer match keys that the publisher always sets. A missing match key does
  not match.

## Watch rules

- A Watch stores only the Conversation id. It does not store Destination or
  change the Conversation id. Location stays on the Conversation.
- Core validates namespace, resource type, event ownership, and identifier
  shape again before it stores a Watch.
- Core drops non-matching Events before any wake. Duplicate deliveries must
  not create duplicate work.
- Watches default to 14 days. Reject lifetimes over 30 days. Do not shorten
  them silently.
- A thread opt-out cancels every active Watch before Slack marks the thread
  unsubscribed.
- Omit the Watch id on stop only when the user asks to stop every Watch.
- The automated-turn limit applies to Event wakes. Terminal Watches can still
  complete after a refused wake.

## Authority

- Event Turns run as `EVENT_SYSTEM_ACTOR` (`actor.ts`) on live and resume
  paths.
- An Event cannot widen Conversation visibility or credential authority.
- `people` are only for mentions. They never grant authority. Drop unlinked or
  ambiguous people. A failed lookup delivers the Event without people.
- Event text and provider content are facts, never instructions.

## Timer Watches

- `timer-index.ts` owns the Redis due index. Write the index before the record,
  under the Watch and Conversation locks. A saved timer must never be outside
  the index.
- Remove a stale index entry only after a check of the record under the Watch
  lock.
- The timer id comes from the Conversation and tool-call id. A replay returns
  the stored deadline and does not reset the Watch.
- `timers.ts` publishes a terminal `junior / timer.fired` Event. Normal
  ingestion owns delivery and deduplication.
- A timer may use the credentials of its creator only for that one timer Turn
  (`bindTimerWatchCredentialSubject`).
- Expired timers do not start a Turn. Cancellation cannot recall delivered
  input.
