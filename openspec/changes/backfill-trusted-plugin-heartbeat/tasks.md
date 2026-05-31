## 1. Backfill

- [x] 1.1 Inventory heartbeat prose, API types, handler, heartbeat runner, context, plugin state/logger, trusted plugin registration, and tests.
- [x] 1.2 Review prior art for cron pulses, bounded background recovery, and narrow trusted extension contexts.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `trusted-plugin-heartbeat`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Rename or alias `JUNIOR_SCHEDULER_SECRET` if heartbeat is no longer scheduler-specific.
- [ ] 2.2 Add explicit heartbeat failure-isolation tests if coverage remains indirect.
- [ ] 2.3 Decide whether plugin logger metadata should be schema-restricted or centrally redacted.
- [ ] 2.4 Move detailed trusted tool-registration behavior to a dedicated spec or keep it under plugin-runtime.
- [ ] 2.5 Document production cron configuration ownership during consolidation.
