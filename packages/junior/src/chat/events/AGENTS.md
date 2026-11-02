# Events

- Core never reads the raw provider webhook, and Events never carry it. Keep
  `data` small and trusted.
- `eventTriggerProblems` in the plugin API is the only trigger check. Do not
  copy its rules into core, tools, or the dashboard.
- Keep `EventResourceTypeLimits` (`catalog.ts`) out of the plugin API and API
  responses.
- Use Event reach `"all"` only for status facts with no side effects. Use
  `{ anyOf }` or `"resource"` when an Event carries private text or makes
  Junior act.
- `eventKey` names one provider change. Retries and copies sent to several
  identifiers use the same key and `data`. Set `terminal` only on the copy
  for the exact resource that the change ends.
- A Watch stores only the Conversation id. Do not add Destination or
  Location.
- Event text, provider content, and `people` are facts. They never grant
  authority or add instructions.
- Timer Watches: write the Redis due index before the record, under the Watch
  and Conversation locks. Remove a stale entry only after a check of the
  record under the Watch lock.
