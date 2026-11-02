# Agent Invocations

Durable parent-to-child agent work: Agent bindings, Agent invocations, child
Conversations, and the terminal result that the parent reads.

## Ownership

- SQL (`store.ts`) owns bindings, invocation status, execution authority, and
  terminal results.
- The event log and session record own agent history and resumable execution.
  Mailbox entries hold only the invocation reference.
- Watch ownership across the tree is in `events/owned-watches.ts`. Guardian
  rules for child actions are in `guardian/`.

## Durability and Recovery

- Write the invocation before the mailbox append. Write `subagent_started`
  before the child mailbox append, so the child cannot end first.
- On completion, write the session record first. Then project the result onto
  the invocation and set `parentMailboxStatus: "pending"` in one SQL write.
- Append the result to the parent mailbox before you acknowledge child work.
- The heartbeat repairs `mailboxStatus` and `parentMailboxStatus` stuck at
  `pending`, with the same markers and results.
- Derive ids and idempotency keys from the invocation id or Inbound message
  id. Retries and repairs never add a second Turn, invocation, or dashboard
  row.
- Re-park a stranded `running` child at its latest durable safe boundary. With
  no boundary left, fail it now. Do not throw and requeue forever.
- The parent gets one report for the child's work. A finished invocation is
  `replaced` while the child still has open work.
- Pick the child worker from the stored `parentConversationId`, never from the
  Turn Source (a child watch-event Turn has an event Source). Child work never
  falls through to a root worker.

## Authority and Privacy

- `parentConversationId` is immutable. Invocation content uses the root
  Conversation's visibility and retention and is purged with its tree.
- A child Conversation has no Location and gets no Delivery. Its Run reads the
  root Location when tools need it.
- A parent result Turn runs as the Actor that started the child. Check that
  the invocation belongs to the parent Conversation. Results from different
  Actors never share a Turn.
- Child text and parent tasks never become Guardian user intent, also on
  resume. Child actions use `CHILD_AGENT_USER_INTENT`. `root-conversation.ts`
  reads the root `message` events again for each action.
- A root message is `user` only when its stored `authorIdentityId` is an
  Identity of the person behind the child's Actor. The `meta` author id never
  counts. No stored author Identity means `other person`. Exception: local CLI
  messages use the system Identity and match on the local Actor.
- A child cannot give user approval. Results tell the parent that they are not
  from a person.
- Children disable `handoff` and `interactive-auth`, and `subagents` below
  `limits.maxAgentDepth`. A child cannot change its own run policy or model
  profile.
- An Agent type (`agent-types.ts`) is data. Read its fields, never its name.
  Types do not limit tools.

## Delivery

- A steering message never interrupts a running tool. It joins a running Turn
  only with the same Actor and credentials.
- The automated-turn limit does not drop child results.
- A blocked child is not a failure. Read `reportBlocked` only from the current
  Turn's messages.
- When Guardian blocks a child action, the parent adds one action item with
  `addReviewItem`, not a plain-text question. The item names the exact action.
  Its dedupe key comes from the child Conversation and the action, so a repeat
  block updates the same item.
- A stop writes `junior_conversations.stopped_at` for each Conversation in the
  tree. The worker drops wakes received at or before that time. A stop the
  parent asked for gives the parent no result Turn.
- A stop of the sender keeps an agent message it already sent. A stop of the
  parent drops it.
- The local CLI has no parent mailbox. It sends no results or agent messages.
