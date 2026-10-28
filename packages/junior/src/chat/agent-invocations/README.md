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
  idempotency key. The invocation stores its model profile and optional
  reasoning level. Later `messageAgent` invocations keep the child's original
  profile.
- A `spawnAgent` invocation stores a short `title` of its task. The parent can
  give the title. If it does not, the tool makes one from the task with the
  fast model, the same way Automations get their titles. A replayed call keeps
  the stored title. An agent invocation that receives a nested result has no
  title.
- An invocation without a name gets an invocation-scoped child conversation.
- `parentConversationId` is immutable. Bindings and invocation content are
  purged with their root Conversation tree. A child cannot hand off its own
  active model profile or otherwise change its run policy.
- An invocation may store an **agent type** (`agent-types.ts`). A child keeps
  its type for later agent invocations, the same as its profile. A type is
  data; runtime code reads its flags, never its name. A type with
  `forkContext` starts the child with the parent's history before the spawn
  call (`fork-history.ts`), and the child commits that history as its own in
  its first checkpoint. Types do not limit tools: Guardian reviews each child
  action against the root user's messages.
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
   The result names the parent's other child agents that are still open, so a
   parent that started several children can wait for all of them before it
   reports.
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
  writes the same two events. A `replaced` result still ends its own row. A
  `steered` agent invocation ends its row when the running Turn reads it.

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
  (`delivery: "queued"`). The idempotency key comes from the parent tool call.
- **Steering a running child.** A running child reads a queued parent message
  as a steering message before its next model call. A running tool is never
  interrupted. The message keeps `defer` mailbox delivery, so it never starts
  an attempt ahead of a paused child. The Turn saves the message, and then its
  agent invocation ends as `completed` with `parentMailboxStatus: "steered"`.
  The running agent invocation reports for both. A message joins only with the
  Actor and credentials of the running Turn. Otherwise it and every later
  parent message wait. If the child finishes without another model call, the
  message runs after that work, and the earlier work ends as `replaced`.
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

A child can use `watchTimer` and `watchEvents` the same as a root, and its
watches belong to the child Conversation. Each batch of watch events starts a
new agent invocation on the child, with the same rules as an Event Turn on a
root: the same burst window, the event system Actor, and a timer's own grants.
Its id comes from the batch's first Inbound message.

Watch event invocations count toward the child's automated-turn limit. A task
or message from the parent resets the count, like a user message on a root.

A parent owns the watches of its child agents and of every child agent below
them. The child still manages its own watches. `events/owned-watches.ts` owns
this rule:

- `listWatches` shows the watches of the current Conversation and of every
  child agent below it. A watch of a child agent has `childAgent`, with the
  child Conversation id and its agent binding name, if it has one.
- `stopWatchingResources` with an id stops a watch of the current Conversation
  or of a child agent below it. It refuses any other id.
- `stopWatchingResources` without an id stops each watch that `listWatches`
  shows, so it also stops the watches of the child agents below. The tool
  keeps its rule: omit the id only when the user asks to stop every watch.
- A child agent never sees or stops a watch of its parent or of a sibling.

Ownership changes only these tools. Each watch still wakes the Conversation
that created it, with the rules above.

When a parent agent stops an active watch of a child agent below it, the child
gets a Conversation note (see `conversations/README.md`). The child reads it in
its next Turn. A stop of a Conversation's own watch adds no note.

## Child Conversations

A Conversation created for an Agent invocation stores `parentConversationId`.
It uses the same Conversation type as all other work. It does not copy the
root Conversation's Location or receive Delivery. Its Run reads the root
Conversation's Location and visibility when tools need them. Output stays
inside Junior. Agent invocation fields still carry the Actor, credentials,
Source, and Destination until the final Run interface removes Destination. The
final Run carries the root Location once, separate from Source and Delivery.

## User Approval

A child agent never has a message from a person. Its task and each later
message come from its parent agent. The child Turn saves that text with
instruction provenance that has no Actor, and the model reads it under a
`[parent agent task]` label. The text never becomes Guardian user intent, also
not on a resumed slice. A child action uses the fixed
`CHILD_AGENT_USER_INTENT` instead.

When Guardian reviews an action of a child, `root-conversation.ts` walks
`parentConversationId` up to the root Conversation. It reads the root's
`message` events, the durable visible transcript. Compaction and handoff never
rewrite these events. Nothing is copied into the child, and nothing new is
stored.

A root Run of a person reads its own Conversation the same way, with the same
labels, so the Actor's earlier messages can authorize an action. The evidence
still has the unlabeled messages. It is the only place that shows the order of
the messages and the tool calls, such as a push that came after a request.
Guardian takes the author of a message only from the root section. A root Run of a system Actor,
such as an Event Turn, does not read it. The person's messages would get the
`other person` label there, so it keeps the unlabeled evidence.

- Only a root message whose author has the same Actor identity as the child
  is labeled `user`. It is compared by platform, team, and user id. When
  either Actor is not known, the message does not count.
- When the root is an Automation run, the dispatch input message is that
  run's own instruction. It is labeled `automation` for the run's system
  Actor. This is the authority that the run already has. Guardian reviews the
  child's action as if the run proposed it: the instruction allows what it
  names. No person can answer in the run, so an action outside the
  instruction is denied, not sent to the user.
- A `user` or `automation` message authorizes the actions that it names. It
  also authorizes the conventional low- or medium-risk steps normally needed
  to deliver that work, within its target and Destination. Guardian uses the
  same scope rule when the action is not from a child. A parent agent task
  can choose those steps, but it cannot add work. Approval of one exact
  action does not cover unrelated, out-of-scope, or high-risk actions.
- Root assistant text, Event Turn inputs such as child results, and messages
  from other people are labeled as context.
- The read happens for each action. A later user message, such as a
  revocation, counts.
- Grandchildren and children started by a result Turn read the same root,
  with no special case.
- The read is bounded to 24,000 characters, with the label of each line
  counted. Messages that can authorize come first, newest first, so a later
  restriction or revocation stays when older messages are cut. The newest 16
  context messages fill the rest. Each gap gets a note in its place, so a
  reply is not read as the answer to a message that is not shown. A cut also
  adds an explicit notice.
- Every kind of line break becomes one line break, so text cannot hide a
  second label inside one line.
- The opening message of the root is always in the read and comes first. For
  an Automation run root, it is the run's instruction, loaded by its message
  id. For another root, it is the oldest message, which usually holds the
  original request. It is not one of the 16 context messages.
- A message keeps the position of its original event. An edit changes only
  its text. An edit of a message older than the read is left out, so an edit
  never moves a message after a newer one, such as a revocation.

Guardian renders the projection outside the untrusted proposal JSON, in a
`<root_user_instructions key="...">` section with a new random key for each
request. Each line has its real author as a prefix. The rules for a child
action are in `guardian/reviewer.ts`. They are adapted from
Codex multi_agent_v2 (`openai/codex` at `f0c5077`,
`guardian-context/src/authorization.rs`) and the Claude Code auto-mode
classifier.

When Guardian asks or denies, the child reports the missing approval with
`reportBlocked` and names the exact action. The parent asks the user one
question and then tells the child to try again.

## Current Boundary

`spawnAgent` exposes durable creation to every parent agent whose app wires
the child-agent worker. It is not an experimental feature; an app config that
still sets `experimental.subagents` is accepted and the key is ignored.
The tool receives the delegated task, optional child name, optional model
profile, and optional per-task reasoning level. The parent should normally
choose a profile that fits the task, using the configured profile descriptions.
Profile names must match the configured profiles. If the parent omits the
profile or passes `null`, the child uses the profile active for the spawning
Turn. The invocation stores this profile, so retries and later `messageAgent`
invocations keep it. A profile's reasoning level applies unless the parent sets
`reasoning_level`.

The runtime derives actor, credentials, destination, visibility, source, parent
conversation, and idempotency from the active tool call. Child runs set
`disabledFeatures: ["handoff", "interactive-auth"]`. With handoff disabled,
the child uses the stored profile on a fixed route and does not call the turn
router. Children cannot hand off models or start interactive OAuth pauses.
They also disable `subagents` when they are deeper than
`limits.maxAgentDepth`.
TODO(dcramer): Issues #881 and #883 track a way for children to force interactive
auth when a delegated tool requires credentials the parent can already request.

`messageAgent` is exposed with `spawnAgent`. A child run always gets it, so it
can message its parent even when it is too deep to start child agents.

`listAgents` is exposed with `spawnAgent` or `messageAgent`, so a child run
always gets it. It lists the agents that the current Conversation can see,
from SQL records, not from model output. Each agent has a `relation`:

- `child`: a direct child agent of the current Conversation.
- `self`, `parent`, and `sibling` appear only for a child agent. `self` and
  each `sibling` are child agents of its parent.
- `parent` has no task. It shows the Conversation execution status of the
  parent, and a failed Turn shows as `idle`.

Each child agent shows the state of its oldest open agent invocation, else of
its latest one. The tool shows two fields:

- `status` is what the child does now: `pending`, `running`, `paused`,
  `idle`, or `stopped`. A child whose latest agent invocation is `completed`,
  `blocked`, or `failed` is `idle`: it waits for an agent message.
- `last_result` is how the newest finished task ended: `completed`, `blocked`,
  or `failed`. A stop, a `replaced` result, and a
  `steered` agent invocation are not results.

Two more rules apply to nested child agents:

- A child whose latest result is `replaced` shows `pending`. Its open child
  work starts another agent invocation on it.
- The task and title come from the latest agent invocation that the parent
  started with `spawnAgent` or `messageAgent`. An agent invocation that gives a
  grandchild result or message, or a watch event, to the child is not a task.

`stopAgent` is exposed with `spawnAgent`. It stops one direct child agent and
every child agent below it:

1. SQL marks each open agent invocation in the tree `stopped`. This frees the
   child's place in the active-child limit. The child keeps its name, and an
   agent message starts new work on it.
2. Results that would still start or report work in the tree become
   `skipped`.
3. A Conversation stop request aborts each run that is still working. Slack and
   ACP use the same stop request.
4. Each Conversation in the tree ends its watches and then records the stop in
   `junior_conversations.stopped_at`. The worker drops watch events, agent
   results, and agent messages received at or before that time, even on an
   idle child.

The Slack `stop` keyword stops a root the same way with
`stopConversationSession`. A turn stop (Slack's stop button, the dashboard, or
a direct stop of a child's run) only interrupts the running work.

The parent asked for the stop, so it gets no result Turn. `listAgents` shows the
child as `stopped`. Any other stop of a child, such as a direct stop of the
child Conversation, also ends its agent invocation as `stopped`. Then the
parent gets an `agent_invocation.stopped` Event, even when the child still has
open work. The child's own child agents stop the same way, so no result of
theirs starts the child again.

A stop request can outlive the run that it stopped. If it wakes the child
again, the latest `stopped` agent invocation handles the wake.
