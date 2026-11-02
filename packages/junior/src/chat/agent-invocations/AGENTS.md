# Agent Invocations

This module owns durable parent-to-child agent work: Agent bindings, Agent
invocations, child Conversations, and the terminal result that the parent
reads. Terms are in `TERMINOLOGY.md`.

## Owns / does not own

- SQL (`store.ts`) owns bindings, invocation status, execution authority, and
  terminal results.
- The conversation event log and session record own agent history and
  resumable execution. Mailbox entries hold only the invocation reference.
- Watch ownership across the agent tree is in `events/owned-watches.ts`.
- Guardian review rules for child actions are in `guardian/`.

## Durability and recovery

- Write the invocation before the mailbox append. Write `subagent_started`
  before the child mailbox append, so the child cannot end first.
- On completion, write the session record first. Then project the result onto
  the invocation and set `parentMailboxStatus: "pending"` in the same SQL
  write.
- Append the result to the parent mailbox before you acknowledge the child
  work.
- The heartbeat repairs `mailboxStatus` and `parentMailboxStatus` that stay
  `pending`. Repairs write the same markers and results.
- Derive ids and idempotency keys from the invocation id or the Inbound
  message id. Retries and repairs must not add a second Turn, invocation, or
  dashboard row.
- Re-park a stranded `running` child at its latest durable safe boundary. If
  no boundary is left, fail it now. Do not throw and requeue forever.
- The parent gets one report for the child's work. A finished invocation is
  `replaced` while the child still has open work.

## Authority and privacy

- `parentConversationId` is immutable. Invocation content uses the root
  Conversation's visibility and retention and is purged with its tree.
- A child Conversation has no Location and gets no Delivery. It does not copy
  the root Location. Its Run reads the root Location when tools need it.
- A parent result Turn runs as the Actor that started the child. Check that
  the invocation belongs to the parent Conversation. Results from different
  Actors never share one Turn.
- Child text and parent tasks never become Guardian user intent, also on
  resume. Child actions use `CHILD_AGENT_USER_INTENT`. `root-conversation.ts`
  reads the root `message` events again for each action.
- A root message is `user` only when its stored `authorIdentityId` is one of
  the Identities of the person behind the child's Actor. The author id in
  `meta` never counts. A message without a stored author Identity is
  `other person`. The local CLI is the one exception: its messages use the
  system Identity, so they match on the local Actor.
- A child cannot give user approval. Results tell the parent that they are not
  from a person.
- Children disable `handoff` and `interactive-auth`. They disable `subagents`
  below `limits.maxAgentDepth`. A child cannot change its own run policy or
  model profile.
- An Agent type (`agent-types.ts`) is data. Read its fields, never its name.
  Types do not limit tools.

## Delivery rules

- A steering message never interrupts a running tool. It joins a running Turn
  only with the same Actor and credentials.
- The automated-turn limit does not drop child results.
- A blocked child is not a failure. Read `reportBlocked` only from the
  messages of the current Turn.
- When Guardian blocks a child action, the parent adds one action item with
  `addReviewItem`, not a plain-text question. The item names the exact action.
  Its dedupe key comes from the child Conversation and the action, so a repeat
  block updates the same item.
- A stop writes `junior_conversations.stopped_at` for each Conversation in the
  tree. The worker drops wakes received at or before that time. A stop that
  the parent asked for gives the parent no result Turn.
- A stop of the sender does not drop an agent message it already sent. A stop
  of the parent does.
- The local CLI has no parent mailbox. It sends no results or agent messages.
