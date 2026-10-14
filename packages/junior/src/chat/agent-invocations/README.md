# Agent Invocations

This module owns durable parent-to-child agent work. It gives delegated work a
stable identity, schedules it through the shared conversation mailbox, and
stores the terminal result for its parent to read later.

## Records

- An **agent binding** maps one name within a parent agent conversation to one
  destinationless child conversation. Named and unnamed children are the same
  kind of work. A name belongs to one child: `spawnAgent` with a name that is
  already used fails with `AgentNameInUseError` and points the model to
  `messageAgent`.
- An **agent invocation** is one retry-safe task sent to a child. Its
  `invocationId` is derived from the parent conversation and caller-supplied
  idempotency key. Optional reasoning level is per-invocation policy, not
  binding state.
- A `spawnAgent` invocation stores a short `title` of its task. The parent can
  give the title. If it does not, the tool makes one from the task with the
  fast model, the same way Automations get their titles. A replayed call keeps
  the stored title. An agent invocation that receives a nested result has no
  title.
- An invocation without a name gets an invocation-scoped child conversation.
- `parentConversationId` is immutable. Bindings and invocation content are
  purged with their root Conversation tree. Children cannot hand off model
  profiles or otherwise override their run policy.
- `limits.maxAgentDepth` is the number of child levels that can start their
  own children. The default, 0, lets only the root start children. The worker
  hides `spawnAgent` from deeper children.
- Each parent may keep at most `MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT`
  child agents with open work. Messages queued for a busy child do not count
  again.
- Each child may have at most `MAX_OPEN_AGENT_INVOCATIONS_PER_CHILD` open
  agent invocations, including the one that runs.

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
  cannot end first. It has the child `conversation_id` and the child name, if
  there is one. For a `spawnAgent` call, it also has the parent tool call id,
  the task, and the title. The agent invocation stores them, so a repaired
  mailbox append writes the same event. The dashboard labels the row with the
  name and the title, or the task when there is no title. It shows them only
  to viewers who can see private content.
- `subagent_ended` is written when the agent invocation is terminal, before the
  parent result is sent. Its outcome is `success`, `blocked`, `error`, or
  `aborted` for a stopped child. The heartbeat result repair also writes it,
  because the child work can be acknowledged before the worker sends the
  result.
- Both events have an idempotency key from the agent invocation id, so retries
  and repairs do not add a second row.
- An agent invocation that receives a nested result has no tool call, but it
  writes the same two events. A `replaced` result still ends its own row.

A child Conversation has no Location, so no Delivery records its visible
messages. The same two writes also add `message` events to the child
Conversation, so the dashboard can show the child transcript:

- The input is a user message. Its id is the mailbox input id, so the child
  Turn links to it.
- A completed result that is not empty is an assistant message. A failed,
  blocked, or stopped child has no reply. Its Turn shows how it ended.

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
- The parent gets the child output as-is. The child runs as the same Actor
  with the same tools, so a label on its output adds no protection. The result
  says that it is not from a person, because a child cannot give user approval.
- The automated-turn limit does not drop results.
- `spawnAgent` returns the child `conversation_id`. The parent reads child
  history with `searchConversationEvents`.
- The local CLI has no parent mailbox, so it does not send results.

### Blocked Reports

A child's reply goes to its parent agent, not to a person, so nobody answers a
question that the child asks. A child run uses the `child_agent` prompt mode,
which replaces the conversation rules, and it has the `reportBlocked` tool. The
child calls it when missing access, input, or a decision stops its task. The
tool ends the run, like `finishAutomationRun` ends an Automation run. The
agent invocation then ends as `blocked`, and the parent result shows what is
missing. A child that cannot get authorization also ends as `blocked`.

The worker and the recovery of a completed child Turn read the report only
from the messages of that Turn. A named child keeps its history, so a report
from an earlier agent invocation does not end a later one.

## Agent Messages

`messageAgent` sends one agent message. Its target is `"parent"`, or the name
or `conversation_id` of a direct child agent. Other Conversations are not
valid targets.

- **Parent to child.** The message is the input of a new agent invocation on
  the child. The child continues its history with the Actor and credentials of
  the parent Run. If the child is idle or stopped, the agent invocation starts
  now (`delivery: "started"`). If the child has open work, the agent
  invocation waits in the child mailbox and runs after that work
  (`delivery: "queued"`). The earlier work then ends as `replaced`, so the
  parent gets one result for both. A running child does not read the message
  in its current Turn. The idempotency key comes from the parent tool call.
- **Child to parent.** The message wakes the parent as an Event with
  namespace `junior` and type `agent.message`. It uses the same mailbox path
  and Actor rules as a child result: the Actor comes from the sender's agent
  invocation in SQL. A root parent runs an Event Turn. A parent that is itself
  a child starts a new agent invocation, the same as for a nested result. The
  sender keeps working, and its result still arrives later. A stop of the
  sender does not drop a message that it already sent. A stop of the parent
  does.
- The local CLI does not send child results or messages to the root, so its
  child runs do not get `messageAgent`.

### Results for a Child

A child Conversation has no Location, so it cannot run an Event Turn. When
`limits.maxAgentDepth` lets a child start its own children, each of their
results starts a new agent invocation on that child instead. Its id comes from
the result's agent invocation id, so retries do not start a second one. An
agent message from one of those children starts an agent invocation the same
way; its id comes from the message's Inbound message id. It uses the parent,
Actor, and credentials of the child's latest agent invocation, and it skips the
queue and active-count checks.

The parent gets one report for the child's work. A finished agent invocation
is `replaced` instead of sent when the child still has open work: another open
agent invocation, an open child, or a sent child result that no agent
invocation has received yet. That work always starts a later agent invocation
on the child, and that agent invocation sends the report. The worker holds
mailbox input while a child is paused, so a child runs one agent invocation at
a time.

### Watches on a Child

A child can use `watchTimer` and `watchEvents` the same as a root. Its watches
belong to the child Conversation. A batch of watch events starts a new agent
invocation on the child, and its result goes to the parent like any other.
It follows the root rules for an Event Turn: it waits out the same burst
window, runs as the event system Actor, and a timer may use the grants of the
person who set it. Its id comes from the first Inbound message of the batch.

Each watch event invocation counts toward the child's automated-turn limit, so
a watch cannot wake the child forever. A `spawnAgent` task or `messageAgent`
message from the parent resets the count, like a user message on a root. A child has no
Location, so it gets no pause notice.

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

`messageAgent` is exposed with `spawnAgent`. A child run always gets it, so it
can message its parent even when it is too deep to start child agents.

`listAgents` is exposed with `spawnAgent`. It lists the direct child agents of
the current Conversation from SQL agent invocation records, not from model
output. Each child shows the state of its oldest open agent invocation, else
of its latest one. The tool shows two fields:

- `status` is what the child does now: `pending`, `running`, `paused`,
  `idle`, or `stopped`. A child whose latest agent invocation is `completed`,
  `blocked`, or `failed` is `idle`: it waits for an agent message.
- `last_result` is how the newest finished task ended: `completed`, `blocked`,
  or `failed`. A stop and a `replaced` result are not results.

Two more rules apply to nested child agents:

- A child whose latest result is `replaced` shows `pending`. Its open child
  work starts another agent invocation on it.
- The task and title come from the latest agent invocation that the parent
  started with `spawnAgent` or `messageAgent`. An agent invocation that gives a
  grandchild result or message to the child is not a task.

`stopAgent` is exposed with `spawnAgent`. It stops one direct child agent and
every child agent below it:

1. SQL marks each open agent invocation in the tree `stopped`. This frees the
   child's place in the active-child limit. The child keeps its name, and an
   agent message starts new work on it.
2. Results that would still start or report work in the tree become
   `skipped`.
3. A Conversation stop request aborts each run that is still working. Slack and
   ACP use the same stop request.
4. The watches of each Conversation in the tree end, so no event wakes a
   stopped child. A child that an agent message starts again sets new watches.

The parent asked for the stop, so it gets no result Turn. `listAgents` shows the
child as `stopped`. Any other stop of a child, such as a direct stop of the
child Conversation, also ends its agent invocation as `stopped`. Then the
parent gets an `agent_invocation.stopped` Event, even when the child still has
open work. The child's own child agents stop the same way, so no result of
theirs starts the child again.

A stop request can outlive the run that it stopped. If it wakes the child
again, the latest `stopped` agent invocation handles the wake.
