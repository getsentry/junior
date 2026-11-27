# Agent teams

An agent starts other agents to do work for it: a Task for work that it
delegates, or a Thread for one work item that people own, message, and
steer. A Lead starts the work of its Space the same way. Each agent is a
Conversation, and every kind uses one set of tools, one update, and one
end-of-Turn contract. A person can see and steer each agent.

## Jobs

- When an agent hands work to other agents, it learns how each one ended
  without checking again, so no agent polls and no agent waits forever.
- When a person wants to steer one piece of work, they can message its
  Thread or ask the agent that started it. Either way, the agent that
  started it gets an update with what the person decided, so the decision
  reaches its other work.
- When an agent needs a person, that person gets one Inbox item from the
  agent that needs them, so no question or answer passes through other
  agents.
- When work moves to a child agent, it runs for the person whose work it
  is, so no agent borrows the access of another Actor.
- When a child agent finishes its task, it leaves the active lists by
  itself, so finished children do not pile up and nobody archives them by
  hand.
- When the way Conversations run gets a fix, the fix reaches every kind of
  agent, so roots, Threads, Tasks, and Leads act the same.

## Rules

**Teams and tools**

- `team` A team is an agent and its child agents. A team sets who manages
  an agent, not who can read it. Visibility and access come from the root,
  as `../policies/conversation-access.md` states.
- `one-toolset` An agent starts, messages, finds, stops, archives, and
  watches other agents with the same tools for every kind. The kind sets
  which arguments a Turn can use, not which tools exist.
- `manages-team` An agent manages only its team. It can message, stop, and
  archive the agents that it started. It can watch other agents that it
  may read.
- `ordinary-conversation` One execution path runs every Conversation. A
  child agent's behavior depends only on whether it is a `task` and on who
  sent the Turn. Its kind never changes. Its parent changes only when a
  person moves it into, out of, or between Spaces.
- `any-shape` The contract does not depend on how many Spaces a person is
  in, or on which kind is the top of a person's work.
- `limits` A parent has at most 8 active child agents.
  Only `limits.maxAgentDepth` levels of child agents can start their own.
  The default is 2, so a Lead's child, or a root's grandchild, can start
  children. With 0, only a root can.

**Authority**

- `one-actor` Each Turn of a child acts for exactly one Actor, with no more
  authority than the parent Turn that gave the work. `startAgent` and
  `messageAgent` pass the current Turn's Actor to the child, and the
  child's result carries its Turn's Actor back.
- `stored-parent` A child accepts a parent message only when it comes from
  its stored parent. It drops all other parent messages.
- `text-is-data` Update text and message text are data. They never give
  approval. The authority of a message comes from the stored relation of
  its sender, as `./guardian.md` states.
- `opaque-ids` A message id is an opaque key. Who sent a message, and what
  it means, come from its stored fields.
- `watch-access` A watch checks access again at each delivery and fails
  closed, before any text from the target reaches the watcher.

**Turns and updates**

- `one-contract` Every agent, except an Automation run, ends a Turn the
  same way. Its final text is its reply. A tool call ends the Turn with no
  reply or as blocked, and the update still carries what that call holds.
- `automation-answers` An Automation run ends each Turn with an answer
  tool, because its reply goes to people in a channel. Stray text never
  posts.
- `final-text` The final text of a Turn is part of the update that the
  agent sends. Only a root delivers it to its Location, so a Lead delivers
  it to its Space. Children show their Turns to people. Final text that was
  cut off, such as by a length limit or an abort, is a failure, not a reply.
  `messageAgent` sends text to another agent at any time. It is not the
  reply, and it does not end the Turn.
- `always-reports` A child agent always tells the agent that started it how
  each Turn ended: its reply, or what it is blocked on. Only a person's
  Turn or an Automation run can end quietly.
- `one-update` Every agent sends one update type, `agent.update`, when a
  Turn ends, waits on a person, is blocked, fails, or stops. Its status is
  `done`, `waiting`, `blocked`, `failed`, or `stopped`. It holds the reply,
  the `noReply` note, the question, the missing part, or the failure, so
  the receiver can act with no read of history. Nothing in it depends on
  the kind.
- `watch-is-start` An agent that starts another watches it, and a watcher
  gets the same update as the agent that started the target. Each update
  starts a Turn, unless the watch makes it quiet, and then it is a
  Conversation note.
- `child-owns-watches` A child owns its Watch work, so the parent does not
  steer each Event.
- `no-early-done` A parent never sees a running child as done. Each result
  names the siblings that did not report yet.
- `push-not-poll` An agent waits for updates. It does not check an agent
  again and again to learn that its work ended.
- `steering` When the next step depends on state that the model cannot see
  before a call, the result of that call says the step: a fact and the
  next step, made by code, in one field, in at most 2 sentences. It never
  gives authority or widens scope.

**People**

- `asker-asks` Any agent, also a child, asks a person only with an Inbox
  item, and only for approval, access, or a decision that is the person's.
  The answer goes to the agent that asked, as the person's own input, and
  to no other Conversation. The agent that started it gets a `waiting`
  update and does not ask again.

**Stops**

- `tree-stop` One stop stops the whole tree below it. When a parent stops a
  child, it gets no result. When a person stops a child, the parent gets
  `stopped`. New work from the parent, or a person's input, ends the stop.
  While stopped, a Conversation keeps its Watches and saves automated input
  as skipped Messages that start no Turn. Only a stop holds input.
- `stopped-parent` A stopped parent gives no new work. Its message to a
  child becomes a note that the child sees when it next runs, and it
  cannot start a child.

**Done and archive**

- `child-done` A child agent is done when it delivered a completed result
  for the latest work from its parent, and nothing in it or below it runs,
  waits on a person, failed in its latest Turn, or has an active Watch.
  What the agent says does not make it done. A done Thread shows under
  Done in the Threads panel, and new work takes it out.
- `tree-auto-archive` Auto-archive treats every Conversation in a tree the
  same way. With the root's setting and grace period, it archives a done
  child before its parent. It never archives a Lead, or a child that a
  person messaged after its parent last gave it work.
- `person-use` An agent cannot archive a Thread that a person messaged
  after the agent last gave it work.
- `auto-restore` New work from its parent, or a new ask for a person,
  restores an auto-archived child. Only a person restores a Conversation
  that a person or an agent archived.
- `archive-stops` Archiving a Conversation stops it and its child agents.

## Open questions

- Can a root Conversation be done, or only idle? A root has no task from a
  parent, so nothing yet says when its work is complete.

## Gaps

- `ordinary-conversation`: some behavior of a child agent depends on its
  kind in more than one place. getsentry/junior#3060, getsentry/junior#4275,
  and getsentry/junior#2567 track it.
- `ordinary-conversation`: a Slack root runs its Turns on a different path
  than other Conversations, so a fix to one path does not reach the other.
  getsentry/junior#2567 tracks it.
- `ordinary-conversation`, `asker-asks`: a Task cannot take a person's
  input, and a Turn that a parent starts in a child does not wait for a
  sign-in.
- `asker-asks`: a child agent cannot ask a person. It reports blocked, and
  its parent asks and passes on the answer.
- `asker-asks`: an Inbox answer goes, as the person, to every Conversation
  that the item links, not only to the agent that asked.
- `asker-asks`: when a person's Turn in a Thread adds an Inbox item, the
  parent gets no `waiting` update. Only a watcher gets it.
- `one-update`: a Turn that only Watch Events started sends no update to a
  Watch, also when it replies. Only the agent that started it gets one.
- `watch-is-start`: a parent cannot make the updates of its child agents
  quiet.
- `push-not-poll`, `steering`: few agent tool results say the next step for
  a working agent, so agents can poll.
- `no-early-done`: a parent message that arrives while a person stops its
  child does not run, and a retried spawn can lose its task to a worker
  that holds the task of the failed spawn. In both cases the parent was
  told that the work started. getsentry/junior#3060 tracks it.
- `tree-stop`: when a stop ends, the parent messages to a grandchild that
  the stop skipped run again.
- `tree-stop`: a stop of a child that ended its last Turn with `noReply`,
  by a person or by the limit of automated Turns, sends its parent no
  `stopped`.
- `opaque-ids`: Junior reads the id of a message or a Turn to tell if it
  came from a Watch Event or from a person's stop.
- `tree-auto-archive`: auto-archive covers only roots, so a done child
  agent stays until a person or its parent archives it.
  getsentry/junior#4409 tracks it.
- `auto-restore`: a parent's message does not restore an archived child,
  and an archived child does not count in its tree's state, so a child
  that needs a person can stay hidden.
- `archive-stops`: `archiveAgent` refuses a working Thread, and the
  dashboard archives a working Conversation and leaves it running.
