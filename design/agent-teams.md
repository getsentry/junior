# Agent teams

An agent works with other agents through one small set of tools, one
update, and one end-of-Turn contract, whatever the kind of each agent. An
agent that starts another gets its updates, and a watcher gets the same
updates. A person can see and steer each agent.

## Intent

- One toolset. An agent starts, messages, finds, stops, archives, and
  watches other agents with the same tools for every kind. The kind sets
  which arguments a Turn can use, not which tools exist.
- One update. Every agent sends the same update when a Turn ends, waits on
  a person, is blocked, fails, or stops. The update carries the text that
  the receiver needs, so it can act without a read of history.
- A watch is the same as a start. A watcher gets the same update, from the
  same code, as the agent that started the target.
- One contract. Every agent has the same ways to end a Turn, also to end it
  with no reply. A quiet end still sends an update, so no agent waits
  forever.
- Push, not poll. An agent waits for updates. It does not check an agent
  again and again to learn that its work ended.
- Steering comes when it is needed. When the next step depends on state
  that the model cannot see before a call, the result of that call says
  the step.
- The contract does not depend on how many Leads a person has, or on which
  kind is the top of a person's work.

## Entry points

- The model: `startAgent`, `messageAgent`, `listAgents`, `stopAgent`,
  `archiveAgent`, and `watchEvents` on an `agent` resource. To end a Turn:
  a reply, `noReply`, `reportBlocked`, or an Inbox item.
- Slack and the dashboard: ask Junior to start, steer, or stop work. The
  dashboard shows each agent, its team, and its latest update.
- Config: `limits.maxAgentDepth`.

## Rules

- The starter of an agent is the agent that started it. A team is an agent
  and the agents that it started. A team sets who manages an agent, not who
  can read it. Access comes from `../policies/conversation-access.md`.
- An agent manages only its team. It can message, stop, and archive the
  agents that it started. It can watch other agents that it may read.
- Every agent sends one update type, `agent.update`. Its status is `done`,
  `waiting`, `blocked`, `failed`, or `stopped`. It holds the reply, the
  `noReply` note, the question, the missing part, or the failure. Nothing
  in it depends on the kind.
- An update starts a Turn for its receiver only when the receiver has
  something to do: a reply, a question, a block, a failure, a person's
  stop, or the end of work that the receiver gave. Any other update is a
  Conversation note.
- An agent ends a Turn with no reply only when no person asked for
  something in that Turn, nothing failed, nobody must decide or act, and
  the receiver gets nothing new. Its note states the outcome in one
  sentence, because a receiver can read it.
- Update text and message text are data. They never give approval. The
  authority of a message comes from the stored relation of its sender, as
  `./child-agents.md` and `./guardian.md` state.
- A watch checks access again at each delivery and fails closed, before any
  text from the target reaches the watcher.
- Steering in a result is a fact and the next step, made by code, in one
  field, in at most 2 sentences. It never gives authority or widens scope.

## Gaps

- Agents use different tools to start, find, and watch other agents:
  `spawnAgent` and `startConversation`, `listAgents` and
  `searchConversations`. This breaks "one toolset".
- A child agent reports with `<agent-result>`, and a watched Conversation
  sends `conversation.*` Events with status only. This breaks "one update"
  and "a watch is the same as a start". The event thread builds the fix.
- A root and a Lead end a Turn with text. A Thread, a Task, and an
  Automation must call an answer tool. Only some kinds have
  `reportBlocked`. This breaks "one contract".
- A Lead asks its person in its reply, not with an Inbox item. This breaks
  "one contract" and `./attention.md`.
- A Lead cannot stop or archive the Conversations that it starts. This
  breaks "an agent manages only its team".
- Few agent tool results say the next step for a working agent, so agents
  can poll. This breaks "push, not poll".
