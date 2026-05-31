## 1. Backfill

- [x] 1.1 Inventory trusted dispatch prose spec, plugin API, validation, store, context, signing, heartbeat recovery, runner, handler, tests, and scheduler integration.
- [x] 1.2 Review prior art for at-least-once background delivery, idempotency, signed callbacks, and Slack destination constraints.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `trusted-plugin-dispatch`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Decide whether dispatch should move to Vercel Queues or remain a signed self-callback loop.
- [ ] 2.2 Add tests for internal handler `waitUntil` behavior and invalid callback responses if coverage remains indirect.
- [ ] 2.3 Add direct tests for auth-required dispatch outcomes becoming `blocked`.
- [ ] 2.4 Decide whether destination postability should be preflighted before record creation.
- [ ] 2.5 Define retention/expiration behavior for plugin-visible lookup after `THREAD_STATE_TTL_MS`.
