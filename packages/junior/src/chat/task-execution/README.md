# Task Execution

This module owns durable mailbox execution for asynchronous conversations.
Queue messages are wake-up hints; persisted mailbox and lease state are the
source of truth. Slack input and plugin dispatches use the same worker loop;
their adapters only prepare input, restore task-specific authority, and accept
the completed result.

## State Model

- A conversation mailbox contains normalized pending work with a durable
  delivery mode: `interrupt` or `defer`.
- Each mailbox entry carries explicit reply delivery. Current Slack work
  delivers to a provider destination; dashboard work may later keep delivery
  in the conversation without changing the conversation's Location.
- A paused turn stores reply delivery on execution until the turn completes or
  dead-letters. Resume and lease-expiry recovery keep that choice so a later
  worker can finish the same reply path.
- A queue payload identifies the conversation to wake; persisted conversation
  work owns Location association and reply delivery separately.
  Provider conversations own their destination, while destinationless
  child work resolves bounded execution authority from its durable
  agent invocation.
- A lease grants one worker temporary execution ownership.
- Dispatch projection updates take a short dispatch lock only while the
  conversation lease is already held. They never wait for conversation work,
  which keeps lock ordering one-way.
- Check-ins extend active ownership and allow heartbeat recovery to distinguish
  slow work from abandoned work.
- Delivery state prevents a completed turn from being posted twice.

Schema-v1 mailbox entries migrate to deferred delivery. Older mailbox entries
without explicit reply delivery inherit destination delivery. Current entries
require valid mailbox and reply delivery values and reject invalid pending work.

`state.ts`, `store.ts`, and their runtime schemas define the persisted shapes.

## Execution

1. Ingress appends mailbox work before sending a queue nudge.
2. The worker validates the queue callback and acquires the conversation lease.
3. While it owns the lease, the worker reloads durable state and routes the next
   work: `interrupt` mailbox delivery first, then a paused turn, then `defer`
   mailbox delivery. Each iteration gets a fresh mailbox delivery attempt.
   New dispatch input identifies its dispatch in mailbox metadata; later slices
   restore that identifier from the turn session rather than queue payloads,
   conversation source, or conversation-id conventions.
   Agent invocation input follows the same rule: the mailbox carries its
   invocation ID, and an empty resume attempt resolves the active invocation
   from SQL.
4. Runtime advances the turn until completion, auth pause, cooperative yield,
   or terminal failure, delivering and recording completed tool-free assistant
   messages as it advances. A requested turn resume is durable state, not an
   in-memory callback; the same worker observes it on the next loop iteration.
   Tool-bearing assistant text remains agent history; explicit progress uses
   the status surface.
5. Work appended under a healthy lease does not send another queue nudge. The
   current worker observes it on its next state reload.
6. Before yielding, the worker commits a safe history boundary, sends another
   nudge, and releases the lease.
7. Accepted provider delivery, intentional no-reply completion, or a durable
   internal result records the terminal turn before acknowledging work.

New messages that arrive during a run remain durable. `interrupt` work is
eligible at the next safe boundary, while `defer` work follows normal ordering
and waits for the next turn.

Slack `@` mentions use `interrupt` delivery; all other inbound messages use
`defer`.

An active turn drains only messages with `interrupt` mailbox delivery. When a
new turn starts, `interrupt` delivery is handled before queued `defer` delivery.

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
