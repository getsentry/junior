## 1. Source Inventory

- [x] 1.1 Review `specs/chat-architecture.md`, `specs/agent-session-resumability.md`, `specs/agent-turn-handling.md`, `specs/slack-ingress-routing.md`, and `specs/testing.md`.
- [x] 1.2 Inspect production Chat SDK queue configuration, state adapter lock/heartbeat/prefix wrapper, thread-message dispatcher, Slack runtime queued-message handling, timeout resume scheduling, and resume lock handling.
- [x] 1.3 Inventory coverage for state-adapter locks, queue dispatch, skipped messages, active-turn continuation rescheduling, resume lock-busy retry/reschedule, and long-turn queue TTL.
- [x] 1.4 Review local Chat SDK prior art: `concurrency: "queue"` serializes handler execution and provides skipped messages, while Junior session history owns durable recovery.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-queue-and-locking`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `queue-and-locking`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/chat-architecture.md` and `specs/agent-session-resumability.md`.
- [ ] 3.2 Decide whether queue entry TTL should be specified as turn timeout plus margin or left configurable.
- [ ] 3.3 Decide whether active lock heartbeat max age belongs here or in state adapter policy.
- [ ] 3.4 Decide whether resume lock busy retry policy should be owned here or entirely by `agent-session-resumability`.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map queue/skipped-message tests currently living under Slack behavior suites to this capability.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-queue-and-locking`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
