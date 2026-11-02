# Agent Dispatch

- Slack Delivery (`../slack/dispatch-turn.ts`) receives only dispatch-owned
  contracts.
- The mailbox carries no credential authority. The first Run reads Actor,
  credential subject, Source, Destination, and plugin metadata from the
  dispatch record.
- Index the dispatch before the mailbox append. `heartbeat.ts` repairs a crash
  between those writes.
- Take the dispatch lock only while you hold the Conversation lease. Never wait
  for a Conversation lease while you hold the dispatch lock.
- Do not store the fallback title. The API shows the Automation name until a
  title is generated.
