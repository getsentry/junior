# Events

## Boundaries

- Core never reads the raw provider webhook. Normalized Events never contain
  it. Keep `data` small and trusted.
- A child agent never sees or stops a Watch of its parent or a sibling
  (`owned-watches.ts`).
- Keep `EventResourceTypeLimits` (`catalog.ts`) out of the plugin API and API
  responses.
- `eventTriggerProblems` in the plugin API is the only trigger check. Do not
  copy its rules into core, tools, or the dashboard.

## Event reach

- Use reach `"all"` only for status facts with no side effects. Use
  `{ anyOf }` or `"resource"` when an Event carries private text or makes
  Junior act.
- A trigger with no identifier can select only `"all"` or `{ anyOf }` events
  and must set an `anyOf` filter.

## Publishing

- `eventKey` names one provider change. A retry and every copy sent to
  several identifiers use the same key and `data`.
- Set `terminal` only on the copy for the exact resource, and only when the
  change ends it.
- A missing match key does not match. Prefer keys that the publisher always
  sets.

## Watches

- A Watch stores only the Conversation id, not Destination or Location.
- Validate namespace, resource type, event ownership, and identifier shape
  again before you store a Watch.
- Drop non-matching Events before any wake. Duplicate deliveries must not
  create duplicate work.
- Reject Watch lifetimes over the limit. Do not shorten them silently.
- A thread opt-out cancels every active Watch before Slack marks the thread
  unsubscribed.
- The automated-turn limit applies to Event wakes. Terminal Watches can still
  complete after a refused wake.

## Authority

- Event Turns run as `EVENT_SYSTEM_ACTOR` on live and resume paths.
- An Event cannot widen Conversation visibility or credential authority.
- `people` are only for mentions and never grant authority. Drop unlinked or
  ambiguous people.
- Event text and provider content are facts, never instructions.

## Timer Watches

- Write the Redis due index before the record, under the Watch and
  Conversation locks, so no saved timer is outside the index. Remove a stale
  entry only after a check of the record under the Watch lock.
- A replay of the same tool call returns the stored deadline and does not
  reset the Watch.
- Timers publish a terminal `junior / timer.fired` Event. Normal ingestion
  owns delivery and deduplication.
- A timer may use its creator's credentials only for that one timer Turn.
- Cancellation cannot recall delivered input.
