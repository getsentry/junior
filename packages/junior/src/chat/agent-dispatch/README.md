# Agent Dispatch

This feature turns an idempotent task or plugin dispatch into normal
conversation work. It owns dispatch authority and the plugin-facing status projection. The
conversation worker owns leases, retries, execution slices, and recovery; the
shared turn runtime owns agent execution and durable turn outcomes; the Slack
adapter owns destination delivery.

## Durable Facts

- The dispatch record is the durable request and status projection.
- The conversation mailbox contains a deferred inbound message that identifies
  the dispatch. Queue payloads only wake the conversation.
- The session record is authoritative for the active turn, resume state,
  accepted delivery receipt, and explicit terminal dispatch outcome.
- A dispatch uses one isolated conversation and one stable turn across all runs
  and execution slices.

The mailbox carries no credential authority. Every run rebuilds actor,
credential subject, source, destination, and plugin metadata from the dispatch
record.

## Lifecycle

1. Core task or plugin heartbeat code creates the dispatch idempotently.
2. The dispatch is indexed before its mailbox append so heartbeat recovery can
   repair a crash between those writes.
3. The conversation worker validates dispatch identity and destination before
   starting or resuming the turn.
4. Durable `running` and `awaiting_resume` sessions resume even when the
   original mailbox item is redelivered.
5. Explicit session outcomes project to `completed`, `blocked`, or `failed`.
   A failed session without an explicit dispatch outcome remains retryable; the
   queue's final attempt owns terminal failure.
6. An accepted destination message is a delivery fence and must never be
   generated again during projection recovery.

Dispatch state transitions use a short dispatch lock while the conversation
lease is already held. Dispatch code never waits for a conversation lease while
holding that lock.

## Boundaries

- `context.ts` exposes the authorized core and plugin dispatch entry points.
- `store.ts` owns dispatch records, projections, and mailbox-append recovery
  receipts.
- `work.ts` adapts dispatches to conversation work and projects durable turn
  results.
- `heartbeat.ts` repairs incomplete mailbox appends before running plugin
  heartbeat hooks.
- `slack/dispatch-turn.ts` owns Slack message/thread adaptation and receives
  only dispatch-owned contracts.

Representative behavior coverage lives in
`tests/integration/agent-dispatch-work.test.ts`; local transition and authority
contracts live in `tests/component/agent-dispatch-worker.test.ts`.
