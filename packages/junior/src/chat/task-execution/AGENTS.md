# Task Execution

This module runs durable Conversation work: mailbox, queue wake, lease, Turn
checkpoint, paused Turns, heartbeat recovery, and the shared worker loop in
`conversation-turn.ts` and `worker.ts`.

## Model

- A queue message only tells a worker to check for work. The mailbox stores
  the work. Do not put work or authority in queue payloads.
- The Conversation lease is the only owner of queue-driven execution. Never
  run one Conversation in parallel. If it is busy, store another wake.
- `checkpoint.ts` is the public Turn progress API. `turn-cursor.ts` is private
  to this module.
- SQL conversation events store history. The Redis Turn cursor stores only
  resume data, including the Source and Actor that started the Turn.
- Dispatch and Agent invocation ids come from mailbox metadata, then from the
  checkpoint. Do not read them from the queue payload, the Conversation
  Source, or Conversation id patterns.
- Child work without a Destination gets its authority from its stored Agent
  invocation.

## Ordering

- Ingress appends mailbox work before it sends a queue nudge.
- Work appended under a healthy lease sends no extra nudge.
- Order: `interrupt` mailbox delivery, then a paused Turn, then `defer`.
  An active Turn drains only `interrupt` work.
- A web Turn drains steered web messages only from the Turn Actor. A Slack
  Turn does not drain web input.
- Dispatch projection updates take the dispatch lock only while they already
  hold the Conversation lease. Lock order stays one-way.

## Durability

- Commit durable state before you acknowledge queue work or yield.
- Before a yield, commit a safe history boundary, send a nudge, then release
  the lease.
- Record the terminal Turn only after accepted delivery, intentional no-reply,
  or a durable internal result.
- Delivery state stops a completed Turn from being posted twice. A delivery
  failure must not mark the Turn delivered.
- Duplicate queue delivery is expected. Handling must be idempotent.
- Authenticate and validate queue callbacks before any state access.

## Recovery

- Soft yield and retry continue only after the boundary advances. Parking the
  same boundary twice fails the Turn.
- Hard timeout may re-park without new work. The slice limit and the durable
  tool-call total still stop endless attempts.
- After a hard-timeout park, hand the lease back. The next slice starts from a
  new queue wake.
- A Turn that loses its worker resumes once from its last save. A second loss
  fails the Turn and keeps committed history.
- Lease expiry permits recovery. It must not erase mailbox work or agent
  history.
- Heartbeats repair missing wakes and abandoned leases. They are not a second
  scheduler for healthy work.
- OAuth callbacks save `turn_authorized` for the exact checkpoint version and
  wake the worker. They never run the agent or write agent history.
- Runtime status is `paused`. The SQL label `awaiting_resume` does not define
  execution state.

## Boundaries

- Queue and heartbeat paths use injected runtime factories, never the
  production singleton.
- Agent failures become a fallback reply when delivery is still possible.
- `tests/integration/durable-queue.test.ts` uses the production
  `createConversationWork`. It may fake only model generation and Slack I/O.
