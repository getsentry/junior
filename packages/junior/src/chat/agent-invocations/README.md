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
  purged with their root Conversation tree. Recursive delegation is disabled
  until depth, cancellation, and authority rules are defined. Children cannot
  spawn, hand off model profiles, or otherwise override their run policy.
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
   result or error onto the invocation.
7. The heartbeat repairs invocations left in `mailboxStatus: "pending"`.

A Conversation created for an Agent invocation stores `parentConversationId`.
It uses the same Conversation type as all other work. It does not copy the
parent Conversation's Location or receive Delivery. Its Run reads the parent
Conversation's Location when tools need it. Output stays inside Junior. Agent
invocation fields still carry the Actor, credentials, Source, and Destination
until the final Run interface removes these older fields.

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
`disabledFeatures: ["handoff", "interactive-auth", "subagents"]` so they cannot
hand off models, start interactive OAuth pauses, or spawn further children.
TODO(dcramer): Issues #881 and #883 track a way for children to force interactive
auth when a delegated tool requires credentials the parent can already request.

This slice does not yet expose result recovery, inject child results into a
parent turn, support recursive children, or implement cancellation. Those
behaviors should build on the invocation record rather than introducing another
scheduler or execution loop.
