## 1. Backfill

- [x] 1.1 Inventory scheduler prose, scheduler package source, Slack tool tests, heartbeat integration tests, and scheduler evals.
- [x] 1.2 Review prior art for cron pulses, Slack scheduled messages, and calendar recurrence.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `scheduler`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Add direct recurrence/cadence tests for DST, weekly weekdays, invalid monthly dates, leap years, and timezone failures.
- [ ] 2.2 Decide whether conversation access should be fetched from Slack metadata instead of inferred from channel id prefix.
- [ ] 2.3 Define private notification behavior for blocked scheduled runs.
- [ ] 2.4 Decide whether scheduled task management needs stricter authorization than active-destination access.
- [ ] 2.5 Expand eval taxonomy to cover scheduled-run execution framing separately from schedule creation.
