# Lead

A Lead is one person's own Conversation with Junior, and the home of the
dashboard. From one transcript, the person finds, starts, and steers all of
their work in Junior. Other Conversations do the work. The Lead keeps track
of it.

## Intent

- One place reaches all of a person's work. A person asks the Lead to find,
  start, check on, or steer work, and does not search lists or share links
  to do it.
- The Lead coordinates and never does the work. Each piece of work runs in
  its own Conversation, with its own context, tools, and history, so the
  Lead stays small and each request gets a focused agent.
- When the person asks for work, the Lead hands it off at once. It looks
  only for a Conversation that already does the work, then steers that one
  or starts a new one. It does not ask the person to start it.
- Work that the Lead starts is ordinary work. Each Conversation it starts
  is a public root that runs as the person, the same as a root that the
  person starts. People find it, join it, and move it to Slack in the
  usual ways.
- The Lead adds no new semantics. Starts, messages, Watches, and action
  review work the same as for every other Conversation. A fix to one of
  those systems applies to the Lead too.
- The Lead archives the work it started when the work is done, so finished
  work does not pile up in the person's lists.
- The Lead is one long transcript that never resets. Compaction keeps it
  usable, so each new request has the context of the earlier ones.

## Entry points

- Dashboard: the home page, "Your Lead". New work starts here. There is no
  separate new conversation page.
- The Lead's tools: `startConversation`, `messageAgent`, the Conversation
  search and read tools, `watchEvents` and timers, the Inbox tools, and the
  Automation tools.

## Rules

- Each person has exactly one Lead. It is private: only that person sees it.
  It does not show in Conversation lists, feeds, or people lists, and it is
  never archived.
- A Lead has no child agents. The Conversations it starts have no parent,
  so the child agent limit does not apply to them.
- A Conversation that the Lead starts is public. Its first message is the
  Lead's brief, and it counts as the person's request
  ([Guardian](./guardian.md)). After that, its own actions get their own
  review.
- Action review lets the Lead start the work that the person asked for. It
  asks only when the Lead starts work on its own, or when the brief goes
  wider than the request.
- The Lead can message a public root where its person is a Participant.
  This exception applies only to the Lead.
- Search looks first at Conversations where the person is a Participant,
  and can also find other Conversations that the person can read.
- The Lead watches each Conversation that it starts, the same as any agent
  that starts another. Each update starts a Lead Turn, and the Lead decides
  whether to tell its person. It hears back from other Conversations only
  through a Watch that it chose to create.
- An Automation that the Lead creates posts to a public Slack channel. An
  Automation never delivers to the Lead or to the dashboard.

## Gaps

- The Lead sometimes works for minutes, then asks the person if it should
  start a Conversation. This breaks "the Lead hands it off at once".
- The Lead sometimes refuses to start a Conversation, and says that a
  public Conversation exposes data to the public. This breaks "work that
  the Lead starts is ordinary work".
- Action review sometimes asks for confirmation when the person asked for
  the work. This breaks the action review rule above.
- The Lead sometimes tells the person to open a new Conversation. This
  breaks "new work starts here".
- The Lead cannot archive a Conversation that it started, so finished work
  stays in the person's lists. This breaks "the Lead archives the work it
  started when the work is done".
- The Lead watches a Conversation that it starts only when the person asks
  to hear back about it. This breaks "the Lead watches each Conversation
  that it starts".
- The Lead finds and messages only public Conversations. It cannot find or
  steer a private Conversation of its person, such as a Slack DM with
  Junior. This breaks "one place reaches all of a person's work" and "can
  also find other Conversations that the person can read".
- With the New dashboard setting on, "New conversation" opens a separate
  page that starts a Conversation without the Lead. This breaks "there is
  no separate new conversation page".
- A person can archive their Lead through the API and the MCP server. This
  breaks "it is never archived".
