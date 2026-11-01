# Agent Dispatch

This module turns an idempotent task or plugin dispatch into normal
Conversation work. It owns dispatch authority and the plugin-facing status
projection.

## Does not own

- Leases, retries, execution slices, and recovery: `../task-execution/`.
- Agent execution and durable Turn outcomes: `../runtime/`.
- Slack Delivery: `../slack/dispatch-turn.ts`. It receives only dispatch-owned
  contracts.

## Invariants

- The dispatch record (`store.ts`) is the durable request and status
  projection. The session record owns the active Turn, resume state, delivery
  receipt, and terminal outcome.
- One dispatch uses one isolated Conversation and one stable Turn across all
  Runs.
- The mailbox carries no credential authority. The first Run reads Actor,
  credential subject, Source, Destination, and plugin metadata from the
  dispatch record.
- Index the dispatch before the mailbox append. `heartbeat.ts` repairs a crash
  between those writes.
- The worker validates dispatch identity and Destination before it starts or
  resumes the Turn.
- An accepted destination message is a delivery fence. Projection recovery
  must never generate it again.
- A failed session without an explicit dispatch outcome stays retryable. The
  final queue attempt owns terminal failure.
- Take the dispatch lock only while you hold the Conversation lease. Never wait
  for a Conversation lease while you hold the dispatch lock.
- Do not store the fallback title. The API shows the Automation name until a
  title is generated.
