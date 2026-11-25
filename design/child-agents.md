# Child agents

An agent starts a child agent to do work for it: a Task for work that it
delegates, or a Thread for one work item that people own, message, and
steer. Each child agent is a Conversation below its parent. A child agent
follows `./agent-teams.md`. This file holds only what the parent and child
relation adds: authority, kinds, limits, stops, and lifecycle.

## Intent

- One execution path runs every Conversation. A child agent has no path of
  its own, so a fix to that path applies to every kind.
- A child owns its Watch work, so the parent does not steer each Event.
- Work never runs with the access of another party. A child, its parent,
  and a grandchild never borrow the authority of a different Actor.
- A parent can plan around its child agents. It knows which ones still
  work, and it learns when one fails or stops.
- A parent manages the lifecycle of its child agents. It starts, steers,
  stops, and archives them, so finished children do not pile up.

## Rules

- A child agent is an ordinary Conversation. Its `kind`, `thread` or
  `task`, is the only switch for its behavior, and it never changes.
- Each Turn of a child acts for exactly one Actor, with no more authority
  than the parent Turn that gave the work. A person's Turn in a Thread
  cannot start or message child agents.
- A child accepts a parent message only when it comes from its stored
  parent. It drops all other parent messages.
- Only a root delivers to its Location. A Thread shows its Turns to people.
- One stop stops the whole tree below it. When a parent stops a child, it
  gets no result. When a person stops a child, the parent gets `stopped`.
  New work from the parent, or a person's input, ends the stop. While
  stopped, a Conversation keeps its Watches and saves automated input as
  skipped Messages that start no Turn. Only a stop holds input.
- A stopped parent gives no new work. Its message to a child becomes a note
  that the child sees when it next runs, and it cannot start a child.
- A parent never sees a running child as done. Each result names the
  siblings that did not report yet.
- A parent has at most 8 active child agents. Only `limits.maxAgentDepth`
  levels of child agents can start their own. The default is 1, so a
  root's child can start children. With 0, only a root can.
- A message id is an opaque key. Who sent a message, and what it means,
  come from its stored fields.
- People decide when a Thread is done. An agent cannot archive a Thread
  that a person messaged after the agent last gave it work.
- Visibility and access come from the root, as
  `../policies/conversation-access.md` states.

## Gaps

- Some behavior of a child agent branches on `kind` outside the one switch.
  This breaks "its `kind` is the only switch". getsentry/junior#3435,
  getsentry/junior#3060, and getsentry/junior#2567 track it.
- When a stop ends, the parent messages to a grandchild that the stop
  skipped run again. This breaks "one stop stops the whole tree".
- A parent does not archive its child agents when their work is done. This
  breaks "a parent manages the lifecycle of its child agents".
- A parent message that arrives while a person stops its child does not
  run, and a retried spawn can lose its task to a worker that holds the
  task of the failed spawn. In both cases the parent was told that the work
  started. This breaks "a parent can plan around its child agents".
  getsentry/junior#3060 tracks it.
- A stop of a child that ended its last Turn with `noReply`, by a person or
  by the limit of automated Turns, sends its parent no `stopped`. This
  breaks "when a person stops a child, the parent gets `stopped`".
- A Task cannot take a person's input, and a Turn that a parent starts in a
  child does not wait for a sign-in. This breaks "a child agent follows
  `./agent-teams.md`".
