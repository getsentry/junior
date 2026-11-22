# Child agents

An agent starts a child agent to do work for it: a Task for work that it
delegates, or a Thread for one work item that people own, message, and
steer. Each child agent is a Conversation below its parent. Only what the
child chooses to report reaches the parent.

## Intent

- One execution path runs every Conversation. A child agent has no path of
  its own, so a fix to that path applies to every kind.
- A parent wakes only when a child messages it. A `reply`, a
  `messageAgent` message, a blocked report, a failure, and a notice that a
  paused child dropped Watch Events are all messages. A child owns its Watch
  work, so the parent does not steer each Event.
- Work never runs with the access of another party. A child, its parent,
  and a grandchild never borrow the authority of a different Actor.
- A parent can plan around its child agents. It knows which ones still
  work, and it learns when one fails or stops.
- A parent manages the lifecycle of its child agents. It starts, steers,
  stops, and archives them, so finished children do not pile up.

## Entry points

- Slack and the dashboard: ask Junior to start a Thread or to delegate work.
  The agent uses `spawnAgent`, `messageAgent`, `stopAgent`, `listAgents`,
  and `archiveAgent`.
- Dashboard: the Threads and Tasks lists of a Conversation, and the page of
  each child agent. People message a Thread on its page.
- Config: `limits.maxAgentDepth`.

## Rules

- A child agent is an ordinary Conversation. Its `kind`, `thread` or
  `task`, is the only switch for its behavior, and it never changes.
- Each Turn of a child acts for exactly one Actor, with no more authority
  than the parent Turn that gave the work. A person's Turn in a Thread
  cannot start or message child agents.
- A child agent never asks a person. It has no Inbox and does not
  wait for a sign-in. Missing access is a blocked report to its parent.
- A child accepts a parent message only when it comes from its stored
  parent. It drops all other parent messages.
- Child output reaches the parent as data, not as instructions. It never
  gives user approval.
- Only a root delivers to its Location. A child keeps its final response,
  and only the text of a `reply` leaves it.
- One stop stops the whole tree below it. When a parent stops a child, it
  gets no result. When a person stops a child, its parent gets `stopped`.
  New work from the parent, or a person's input, ends the stop.
- A parent never waits forever, and never sees a running child as done.
  Each result names the siblings that did not report yet. A Task that fails,
  or still has no answer after one reminder, tells its parent `failed`. A
  Thread keeps its failure.
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
- Some input to a child agent runs in a separate child worker, not in
  the path that runs every Conversation. This breaks "one execution path
  runs every Conversation". getsentry/junior#3060 tracks it.
- When a stop ends, the parent messages to a grandchild that the stop
  skipped run again. This breaks "one stop stops the whole tree".
- A Watch Turn of a child that ends with `noReply` keeps the child in the
  siblings that did not report. The parent waits for a report that does not
  come. This breaks "a parent never waits forever".
- A parent does not archive its child agents when their work is done. This
  breaks "a parent manages the lifecycle of its child agents".
- A parent cannot archive a Task. Only a Thread can be archived. This
  breaks "a parent manages the lifecycle of its child agents".
- For some child messages, Junior reads the sender from the message id.
  This breaks "a message id is an opaque key".
