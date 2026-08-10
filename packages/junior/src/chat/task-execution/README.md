# Task Execution

This module runs durable work for asynchronous conversations.

A queue message only tells a worker to check for work. The mailbox stores the
work. The lease lets one worker run the conversation at a time. Slack input and
plugin dispatches use the same worker loop. Their adapters prepare input and
accept the result.

`checkpoint.ts` is the public API for turn progress. Use
`loadTurnCheckpoint` and `saveTurnCheckpoint`. `turn-cursor.ts` stores the
checkpoint and is private to this module.

`turn-wake.ts` wakes paused turns. `paused-turn.ts` runs them under the
conversation lease. SQL conversation events store history. The Redis turn
cursor stores only the data that is needed to resume a turn.

The reliability rules are small:

- The conversation lease is the only owner for queue-driven execution.
- A turn may run, pause at a committed boundary, complete, or fail.
- Timeout, retry, and yield may continue only after the boundary advances;
  parking the same boundary twice fails the turn.
- A paused turn can continue under the current lease while the host request has
  time left. When that deadline is spent, the worker releases the lease. The
  next slice starts from a fresh queue wake and request deadline.
- A process can stop while a turn runs. The next worker stops that turn and
  records the error. The user can start new work. Committed SQL history remains.
- A paused turn does not take a second lock. OAuth can run outside the queue and
  uses the thread lock.

Runtime and Redis status is `paused`. SQL free-text / enum rows may still say
`awaiting_resume`; that historical SQL label does not define execution state.

## State Model

- A conversation mailbox contains pending work. Each item has an `interrupt`
  or `defer` mailbox delivery and a `publishExternally` flag. The worker keeps
  different publish choices in separate turns.
- A queue message identifies the conversation to wake. The stored work controls
  delivery. A provider conversation stores its destination. Child work without
  a destination gets its authority from its stored agent invocation.
- `publishExternally` means the turn also publishes assistant output to the
  conversation destination. The conversation log always stores the turn.
  Dashboard and destinationless work leave the flag false. Slack ingress and
  Slack resume default to publish when the flag is unset. Destination presence
  must not invent publish.
- A lease grants one worker temporary execution ownership.
- Dispatch projection updates take a short dispatch lock only while the
  conversation lease is already held. They never wait for conversation work,
  which keeps lock ordering one-way.
- Check-ins extend active ownership and allow heartbeat recovery to distinguish
  slow work from abandoned work.
- Delivery state prevents a completed turn from being posted twice. The turn
  checkpoint keeps `publishExternally` across pause and yield; worker execution
  state does not duplicate it.

Redis execution state uses the new v2 keys. This release does not read or move
old Redis state. Old mailbox, lease, and turn-cursor state can be lost.
Committed SQL history remains. The code has no old-state reader, dual write, or
rollback support.

`checkpoint.ts`, `turn-wake.ts`, `paused-turn.ts`, `state.ts`, `store.ts`, and
`worker.ts` define the execution surface.

## Execution

1. Ingress appends mailbox work before sending a queue nudge.
2. The worker validates the queue callback and acquires the conversation lease.
3. While it owns the lease, the worker reloads durable state and routes the next
   work: `interrupt` mailbox delivery first, then a paused turn, then `defer`
   mailbox delivery. Each iteration gets a fresh mailbox delivery attempt.
   New dispatch input identifies its dispatch in mailbox metadata; later slices
   restore that identifier from the turn checkpoint rather than queue payloads,
   conversation source, or conversation-id conventions.
   Agent invocation input follows the same rule: the mailbox carries its
   invocation ID, and an empty resume attempt resolves the active invocation
   from SQL.
4. The runtime runs the turn until it completes, pauses for authorization,
   yields, or fails. It delivers and records complete assistant messages that
   have no tool call. A resume request is stored state. The same worker sees it
   on the next loop. Assistant text with a tool call stays in agent history.
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
- If a conversation is busy, store another wake. Do not run it in parallel.
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

## Integration Contract

`packages/junior/tests/integration/durable-queue.test.ts` uses the same
`createConversationWork` composition as production. These tests must not replace
Junior-owned runtime behavior. They may fake only model generation at the
`executeAgentRun` stream boundary and Slack I/O at the adapter boundary. The
agent runtime, resume logic, checkpoint, worker, lease, mailbox, and queue
routing must run unchanged. The memory `StateAdapter` and in-memory queue
implement production ports. Separate contract tests cover provider storage,
Vercel signing, and Vercel options. The cases describe the expected product
behavior:

- **Success:** accepted input runs once, commits SQL history, delivers once, and
  drains.
- **Interrupts:** an explicit instruction received during a run steers the active
  turn; an authorization request parks the turn without retrying it.
- **Failures:** failure before input commit retries without duplicate delivery;
  a timeout pause under a spent request deadline leaves the host request so the
  next slice starts fresh; the agent runtime keeps the existing same-boundary
  no-progress check; an expired worker lease stops its stranded running turn while
  preserving committed history; and repeated agent failure stops at the retry
  limit with at most one visible fallback. Each stopped state must allow a later
  user request to complete.

Broader heartbeat scheduling remains in
`packages/junior/tests/integration/heartbeat.test.ts`. Component tests own
isolated transition details; they should not duplicate these end-to-end
contracts.
