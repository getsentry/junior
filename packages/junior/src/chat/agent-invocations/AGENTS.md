# Agent Invocations

- Mailbox entries hold only the invocation reference. SQL (`store.ts`) owns
  invocation status, execution authority, and terminal results.
- Write the invocation before the mailbox append. Write `subagent_started`
  before the child mailbox append, so the child cannot end first.
- Append the result to the parent mailbox before you acknowledge child work.
- Derive ids and idempotency keys from the invocation id or Inbound message
  id, so retries and repairs never add a second Turn, invocation, or row.
- Pick the child worker from the stored `parentConversationId`, never from the
  Turn Source (a child watch-event Turn has an event Source).
- A child has at most one `running` or `paused` agent invocation. Before the
  worker starts one, it ends every other active one of that child. Each ended
  one sends its own result to the parent.
- An Agent type (`agent-types.ts`) is data. Read its fields, never its name.
  Types do not limit tools.
