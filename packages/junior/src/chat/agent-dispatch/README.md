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

The mailbox carries no credential authority. The first Run reads Actor,
credential subject, Source, Destination, and plugin metadata from the dispatch
record. The Turn saves Actor for later Runs. The dispatch record remains the
authority for the other facts until their owning contract changes.

## Conversation Title

A dispatched run has no human message. The run input is a bot-authored user
message, so the shared title generator uses it as the title source.

- Core automations give the Automation title to `enqueueAgentDispatch`. The
  title is stored as a provisional title when the Conversation is first
  recorded.
- The first generated run title replaces the provisional title once. After
  that, the title is final.
- If generation fails, the provisional title stays. A later transcript write
  tries generation again.
- A run without any title shows "Automation run" in the dashboard.

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
