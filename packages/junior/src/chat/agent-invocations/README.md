# Agent Invocations

This module owns durable parent-to-child agent work. It gives delegated work a
stable identity, schedules it through the shared conversation mailbox, and
stores the terminal result for its parent to read later.

## Records

- An **agent binding** maps one name within a parent agent conversation to one
  destinationless child conversation. Named and unnamed children are the same
  kind of work; a name only keeps the same child conversation id so later inputs
  continue that child's history.
- An **agent invocation** is one retry-safe task sent to a child. Its
  `invocationId` is derived from the parent conversation and caller-supplied
  idempotency key. Optional reasoning level is per-invocation policy, not
  binding state.
- An invocation without a name gets an invocation-scoped child conversation.
- `parentConversationId` is immutable. Bindings and invocation content are
  purged with their root Conversation tree. Children cannot hand off model
  profiles or otherwise override their run policy.
- `limits.maxAgentDepth` is the number of child levels that can start their
  own children. The default, 0, lets only the root start children. The worker
  hides `spawnAgent` from deeper children.
- Each parent may keep at most
  `MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT` non-terminal child invocations in
  flight (named busy-locking is separate and still applies per name).

SQL owns bindings, invocation status, bounded execution authority, and terminal
results. The conversation event log and session record continue to own agent
history and resumable execution. Mailbox entries contain only the invocation
reference needed to join those records. Invocation content inherits the root
conversation's visibility and retention window and is deleted with that
conversation tree.

## Execution

1. Creation writes the invocation before attempting the mailbox append.
2. The idempotent mailbox append sends a normal conversation queue wake.
3. The invocation router recognizes destinationless child work and advances it
   through the shared `AgentRunner`.
4. A cooperative yield keeps the same turn and invocation active for another
   execution slice.
5. A stranded `running` child is re-parked at its latest durable safe boundary.
   If no model or resumable boundary remains, the session fails immediately and
   projects onto the invocation. Empty resume wakes never become final delivery
   attempts, so unrecoverable stranded work must not throw and requeue forever.
6. Completion writes the session record first, then projects the immutable
   result or error onto the agent invocation. The same SQL write sets
   `parentMailboxStatus: "pending"`.
7. The worker appends the result to the parent mailbox before it acknowledges
   the child work. Then it sets `parentMailboxStatus: "appended"`.
8. The heartbeat repairs invocations left in `mailboxStatus: "pending"` or
   `parentMailboxStatus: "pending"`.

## Dashboard Markers

Each agent invocation writes two events to its parent Conversation. The
dashboard pairs them to show the child and its status.

- `subagent_started` is written before the child mailbox append, so the child
  cannot end first. It has the child `conversation_id` and, for a `spawnAgent`
  call, the parent tool call id. The agent invocation stores that id, so a
  repaired mailbox append writes the same event.
- `subagent_ended` is written when the agent invocation is terminal, before the
  parent result is sent. Its outcome is `success`, `blocked`, `error`, or
  `aborted` for a stopped child. The heartbeat result repair also writes it,
  because the child work can be acknowledged before the worker sends the
  result.
- Both events have an idempotency key from the agent invocation id, so retries
  and repairs do not add a second row.
- An agent invocation that receives a nested result has no tool call, but it
  writes the same two events. A `replaced` result still ends its own row.

## Parent Results

A terminal result wakes the parent Conversation as a core Event without a
Watch. The Event has namespace `junior` and type `agent_invocation.completed`,
`agent_invocation.blocked`, `agent_invocation.failed`, or
`agent_invocation.stopped`. It uses the same
mailbox metadata and wait window as Watch Events, but it has no
`subscriptionId`.

- The parent Inbound message id comes from the agent invocation id, so retries
  do not add a second parent Turn.
- The parent Turn runs as the Actor that triggered the child, user or system.
  This is on purpose: the result continues that Actor's work. The worker reads
  the Actor from SQL and checks that the agent invocation belongs to the parent
  Conversation. A delegated credential subject of a system Actor is not passed
  to the result Turn yet.
- Results from different Actors never share one Turn.
- The child result is model output. The parent gets it as information, not
  instructions.
- The automated-turn limit does not drop results.
- `spawnAgent` returns the child `conversation_id`. The parent reads child
  history with `searchConversationEvents`.
- The local CLI has no parent mailbox, so it does not send results.

### Results for a Child

A child Conversation has no Location, so it cannot run an Event Turn. When
`limits.maxAgentDepth` lets a child start its own children, each of their
results starts a new agent invocation on that child instead. Its id comes from
the result's agent invocation id, so retries do not start a second one. It uses
the parent, Actor, and credentials of the child's latest agent invocation, and
it skips the busy and active-count checks.

The parent gets one report for the child's work. A finished agent invocation
is `replaced` instead of sent when the child still has open work: another open
agent invocation, an open child, or a sent child result that no agent
invocation has received yet. That work always starts a later agent invocation
on the child, and that agent invocation sends the report. The worker holds
mailbox input while a child is paused, so a child runs one agent invocation at
a time.

## Child Conversations

A Conversation created for an Agent invocation stores `parentConversationId`.
It uses the same Conversation type as all other work. It does not copy the
root Conversation's Location or receive Delivery. Its Run reads the root
Conversation's Location and visibility when tools need them. Output stays
inside Junior. Agent invocation fields still carry the Actor, credentials,
Source, and Destination until the final Run interface removes Destination. The
final Run carries the root Location once, separate from Source and Delivery.

## Current Boundary

`spawnAgent` exposes durable creation to a parent agent when the experimental
`subagents` feature is enabled via
`createApp({ experimental: { subagents: true } })` (or automatically in
`junior chat`, the local createApp-equivalent entrypoint). It is off by default
so deployments can ship the runtime without advertising the model-facing tool. The
tool receives only the delegated task, optional child name, and optional
per-task reasoning level. The runtime derives actor, credentials, destination,
visibility, source, parent conversation, and idempotency from the active tool
call. Child runs set
`disabledFeatures: ["handoff", "interactive-auth"]` so they cannot hand off
models or start interactive OAuth pauses. They also disable `subagents` when
they are deeper than `limits.maxAgentDepth`.
TODO(dcramer): Issues #881 and #883 track a way for children to force interactive
auth when a delegated tool requires credentials the parent can already request.

`listAgents` is exposed with `spawnAgent`. It lists the direct child agents of
the current Conversation from SQL agent invocation records, not from model
output. Each child shows the state of its oldest open agent invocation, else
of its latest one. Two more rules apply to nested child agents:

- A child whose latest result is `replaced` shows `pending`. Its open child
  work starts another agent invocation on it.
- The task is the input of the latest agent invocation that the parent
  started. An agent invocation that gives a grandchild result to the child is
  not a task.

`stopAgent` is exposed with `spawnAgent`. It stops one direct child agent and
every child agent below it:

1. SQL marks each open agent invocation in the tree `stopped`. This frees the
   child's name and its place in the active-child limit.
2. Results that would still start or report work in the tree become
   `skipped`.
3. A Conversation stop request aborts each run that is still working. Slack and
   ACP use the same stop request.

The parent asked for the stop, so it gets no result Turn. `listAgents` shows the
child as `stopped`. Any other stop of a child, such as a direct stop of the
child Conversation, also ends its agent invocation as `stopped`. Then the
parent gets an `agent_invocation.stopped` Event.

A stop request can outlive the run that it stopped. If it wakes the child
again, the latest `stopped` agent invocation handles the wake.
