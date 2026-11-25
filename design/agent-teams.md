# Agent teams

An agent works with other agents through one small set of tools, one
update, and one end-of-Turn contract, whatever the kind of each agent. An
agent that starts another gets its updates, and a watcher gets the same
updates. A person can see and steer each agent. What a parent and its
child agents add to this is in `./child-agents.md`.

## Intent

- One toolset. An agent starts, messages, finds, stops, archives, and
  watches other agents with the same tools for every kind. The kind sets
  which arguments a Turn can use, not which tools exist.
- One update. Every agent sends the same update when a Turn ends, waits on
  a person, is blocked, fails, or stops. The update carries the text that
  the receiver needs, so it can act without a read of history.
- A watch is the same as a start. A watcher gets the same update, from the
  same code, as the agent that started the target.
- One contract. Every agent, except an Automation run, ends a Turn the same
  way. Its final text is its reply. A tool call ends the Turn with no reply
  or as blocked, and the update still carries what that call holds. So a
  quiet end still reaches the receiver, and no agent waits forever.
- An Automation run is the one exception, because its reply goes to people
  in a channel. It must end each Turn with an answer tool, so that stray
  text never posts.
- The agent that needs a person asks that person. No agent passes on a
  question or an answer for another agent.
- Push, not poll. An agent waits for updates. It does not check an agent
  again and again to learn that its work ended.
- Steering comes when it is needed. When the next step depends on state
  that the model cannot see before a call, the result of that call says
  the step.
- The contract does not depend on how many Spaces a person is in, or on
  which kind is the top of a person's work.

## Rules

- A team is an agent and the agents that it started: its child agents, and
  the roots that a Lead starts. A team sets who manages an agent, not who
  can read it. Access comes from `../policies/conversation-access.md`.
- An agent manages only its team. It can message, stop, and archive the
  agents that it started. It can watch other agents that it may read.
- Archiving a Conversation stops it and its child agents.
- The final text of a Turn is the reply. It is part of the update that the
  agent sends, and a root also delivers it to its Location and a Lead to its
  Space. Final text that was cut off, such as by a length limit or an
  abort, is a failure, not a reply. `messageAgent` sends text to another
  agent at any time. It is not the reply, and it does not end the Turn.
- `noReply` ends the Turn with no reply. `reportBlocked` ends it as blocked
  on what the agent that started it can give. Each still sends an update with its note or
  the missing part.
- An agent ends a Turn with no reply only when no person asked for
  something in that Turn, nothing failed, nobody must decide or act, and
  the receiver gets nothing new. Its note states the outcome in one
  sentence, because a receiver can read it.
- Any agent, also a child, asks a person only with an Inbox item, and only
  for approval, access, or a decision that is the person's. The answer goes
  to the agent that asked, as the person's own input, and to no other
  Conversation. The agent that started it gets a `waiting` update and does
  not ask again.
- Every agent sends one update type, `agent.update`. Its status is `done`,
  `waiting`, `blocked`, `failed`, or `stopped`. It holds the reply, the
  `noReply` note, the question, the missing part, or the failure. Nothing
  in it depends on the kind.
- An agent that starts another watches it. Each update reaches every
  watcher the same way: it starts a Turn, unless the watch makes it quiet,
  and then it is a Conversation note.
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
- A Thread and a Task must call `reply`, and their final text goes nowhere.
  Only some kinds have `reportBlocked`. This breaks "one contract".
- A child agent cannot ask a person. It reports blocked, and its parent
  asks and passes on the answer. This breaks "the agent that needs a person
  asks that person".
- An Inbox answer goes, as the person, to every Conversation that the item
  links, not only to the agent that asked. This breaks "no agent passes on
  a question or an answer for another agent".
- A Turn that ends with `noReply` while the agent has a Watch sends no
  update, also after the Watch ends. This breaks "a quiet end still reaches
  the receiver".
- When a root, a Lead, or a person's Turn in a Thread ends with final text
  that was cut off, Junior counts it as a reply. This breaks "final text
  that was cut off is a failure".
- A Lead asks people in its reply, not with an Inbox item. This breaks
  "one contract" and `./inbox.md`.
- A root that a Lead starts stores no link to the Lead, and the Lead's task
  counts as a person's message. So the Lead cannot stop or archive it. This
  breaks "an agent manages only its team".
- Few agent tool results say the next step for a working agent, so agents
  can poll. This breaks "push, not poll".
- A parent cannot make the updates of its child agents quiet. This breaks
  "a watch is the same as a start".
- A Turn that only Watch Events started sends its watchers no update, also
  when it replies. This breaks "one update".
- When a person's Turn in a Thread adds an Inbox item, the parent gets no
  `waiting` update. Only a watcher gets it. This breaks "the agent that
  started it gets a `waiting` update".
- Archiving does not stop work. `archiveAgent` refuses a working Thread,
  and the dashboard archives a working Conversation and leaves it running.
  This breaks "archiving a Conversation stops it and its child agents".
