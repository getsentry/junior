# To-dos

An agent keeps To-dos for work that outlives a Turn in its Conversation:
work that it queues for a later Turn, work that it gives a child agent, and
work that only a person can do. People see the list on the Conversation,
and each person sees their own To-dos in their Inbox.

## Intent

- No queued work is lost when history is compacted or sandbox files go
  away. To-dos are an agent's only durable backlog.
- A parent can see which work still waits on which child agent.
- Work that needs a person reaches their Inbox as a "To do for you" item,
  as `./inbox.md` states.
- When a person or a child agent changes a To-do, the agent sees only that
  change in its next Turn, so it acts on it without reading the whole list
  again.

## Rules

- An agent adds a To-do only for work that outlives the Turn. To-dos are
  not a checklist for one Turn, and they are not a plan.
- Each To-do has one assignee: the Conversation's own agent, one of its
  child agents, or a person.
- The Conversation's agent changes its To-dos. A person can change the
  status of a To-do. A child agent can only set the To-dos that are
  assigned to it to done or dropped.
- When a child agent is archived, its open To-dos close as done. A child's
  result does not close them, because a child that watches work reports
  after each Turn while that work goes on.
- When a child agent is stopped, its open To-dos are dropped.
- If the To-dos cannot load for a Turn, the agent is told that they did not
  load, so it does not read a missing list as no To-dos.

## Gaps

- A child's result that says it is done closes its open To-dos, and
  archiving the child does not close them. This breaks "when a child agent
  is archived, its open To-dos close as done".
- When a child is stopped between Turns, its parent gets no result, so the
  child's open To-dos stay open. This breaks "when a child agent is
  stopped, its open To-dos are dropped".
