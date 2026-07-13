# Task Execution

This module owns durable mailbox execution for provider-backed conversations.
Queue messages are wake-up hints; persisted mailbox and lease state are the
source of truth.

## State Model

- A conversation mailbox contains normalized pending user work.
- A queue payload identifies the conversation and destination needed to resume
  processing; it does not carry authoritative conversation content.
- A lease grants one worker temporary execution ownership.
- Check-ins extend active ownership and allow heartbeat recovery to distinguish
  slow work from abandoned work.
- Delivery state prevents a completed turn from being posted twice.

`state.ts`, `store.ts`, and their runtime schemas define the persisted shapes.

## Execution

1. Ingress appends mailbox work before sending a queue nudge.
2. The worker validates the queue callback and acquires the conversation lease.
3. It drains available mailbox messages into durable agent history.
4. Runtime advances the turn until completion, auth pause, cooperative yield,
   or terminal failure.
5. Before yielding, the worker commits a safe history boundary, sends another
   nudge, and releases the lease.
6. After successful destination delivery, it records the assistant message and
   delivered turn before acknowledging work.

New messages that arrive during a run remain durable and are drained at the
next safe boundary or subsequent wake-up.

## Queue And Lease Rules

- Duplicate queue delivery is expected and must be idempotent.
- Queue authentication and payload validation happen before state access.
- A busy conversation should be retried through durable wake-up state, not
  parallel execution.
- Lease expiry permits recovery; it must not erase mailbox or agent history.
- Heartbeats repair missing wake-ups and abandoned leases without becoming a
  second scheduler for healthy work.
- Queue and heartbeat paths depend on injected runtime factories, never the
  production composition singleton.

## Failure Ownership

- Invalid callbacks fail at the HTTP boundary.
- Transient queue or storage failures may be retried by their owning adapter.
- Agent failures become a finalized fallback reply when delivery remains
  possible.
- Delivery failures leave enough durable state for safe retry and must not mark
  the turn delivered.

Representative tests live in `packages/junior/tests/integration/heartbeat.test.ts`
and the task-execution integration suites.
