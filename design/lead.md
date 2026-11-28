# Lead

Each Space has one Lead: the agent at the root of the Space's tree
(`./spaces.md`). Members bring it one body of work, and it is accountable
for getting that work done. It scopes the work, runs it through Threads,
checks what comes back. Its Threads are its plan. Threads change code and
systems. The Lead reads, checks, decides, and asks members only for what is
theirs to decide.

## Intent

- The Lead manages and does not do the work. It hands each request that
  changes something to a Thread at once, and answers directly when reads
  are enough. So its context holds the plan, not tool output, over weeks of
  work and many Threads.
- A curated manager tool set, not every tool. The Lead gets the tools to run
  Threads, read, and ask members. It gets no tool that writes
  or runs code. So each side effect has an owner Thread, a transcript, and
  action review, and never acts for whoever last spoke to the Lead.
- Code keeps the Lead on track, not only the prompt. Which tools it lists
  and when its text posts are set by the runtime.
- Quiet by default. The Lead posts when it starts work, and when work is
  done, blocked, or needs a member. A routine child update ends with no
  reply.
- A child's result is a claim. The Lead does not report it as fact until a
  source confirms it, through its own reads or a Thread that checks.
- Members' attention is scarce. The Lead asks a member only for a decision
  that is theirs, with an Inbox item, and makes every other call itself.

## Rules

**Tools**

- The Lead lists only the tools its job needs: to start, steer, stop, and
  archive its Threads; to read Conversations and provider state; to ask
  members with Inbox items; to watch Events and time; and to move
  Conversations and change settings for a member.
- The Lead never lists a tool that writes or runs code, such as Sandbox
  tools, skills, provider tools that write, or Automation tools. A Thread
  does that work, and the Lead names the skill in the Thread's task.
- Only a member's Turn changes settings or moves a Conversation.

**Turns**

- When a member starts a Turn, the Lead's final text is its reply.
- When a child, an Event, or an Inbox answer starts a Turn, final text does
  not post. The Lead posts only with an explicit reply, or ends the Turn
  with `noReply`.
- A child's `done` update reaches the Lead as a Conversation note and starts
  no Turn. `waiting`, `blocked`, `failed`, and `stopped` start a Turn.
- The Lead sees a child's result as that child's claim, apart from runtime
  facts.

## Gaps

- The Lead lists no `askUserQuestion`, `updateInboxItem`, or provider read
  tools yet. So it asks members in its reply, and it cannot check a child's
  claim. getsentry/junior#4421 tracks it.
- On a Turn that a child or an Event started, the Lead's final text posts.
  This breaks "quiet by default".
- Every child update starts a Lead Turn, also `done`. getsentry/junior#4413
  tracks it.
- A child's result reaches the Lead as current state, not as a claim. This
  breaks "a child's result is a claim".
