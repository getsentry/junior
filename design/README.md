# Design

Each file states the intent of one major system: the goals it must meet
and the rules users rely on. Teammates read it to learn
why the system works the way it does. Agents read it before they change the
system. The `create-design-docs` skill writes these files, and the
`automate-design-doc-updates` skill checks the product against them. Both
skills live in getsentry/junior-prod.

## File contract

Each file has an H1 title and one paragraph that says what the user gets.
Then it has these H2 sections, in this order:

1. `Intent`: the goals that the system must meet, and why. Each goal
   decides between real options, such as "runs work with no person
   present".
2. `Rules`: limits that users rely on, such as who can act, and what the
   system is not.
3. `Gaps`: only when the product does not meet a goal or a rule yet. Say
   how it falls short, and which goal or rule it breaks.

These files state intent. The code shows what the product does, not what it
should do. Do not change a goal or a rule only to match the code. Name only
user actions, visible names, required access, and outcomes that a user can
see. Leave out source paths, symbols, schemas, history, and rollout notes.
Use the words in `../TERMINOLOGY.md`.

Do not list behaviors. The verification map in
`.agents/skills/verify-junior/` owns each behavior as a claim with a proof. Name a behavior only by its claim ID, such as
`automations#run-now`, and do not restate it.

## Systems

- [Agent teams](./agent-teams.md): how agents start, message, watch, and
  report to each other, and how each one ends a Turn.
- [Annotations](./annotations.md): the objects that a Conversation created,
  changed, or attached.
- [Automations](./automations.md): saved instructions that Junior runs later.
- [Cache warming](./cache-warming.md): keeping the prompt cache of an idle
  Conversation warm while a return is likely.
- [Child agents](./child-agents.md): Threads and Tasks that an agent starts
  to do work for it.
- [Context compaction](./context-compaction.md): summaries that replace old
  history, and the prompt cache of an idle Conversation.
- [GitHub](./github.md): code, pull requests, and issues in GitHub repos.
- [Google Workspace](./google.md): Calendar, Docs, Sheets, and Slides
  through Junior's own Google account.
- [Guardian](./guardian.md): review of each tool action before it runs.
- [Inbox](./inbox.md): work that waits for a person.
- [Inbox stacks](./inbox-stacks.md): the Inbox rows in the dashboard, one
  stack for each root Conversation.
- [Prompts](./prompts.md): what the model reads in each Turn, and who wrote
  each part.
- [Sandbox credentials](./sandbox-credentials.md): provider access for
  commands in a Sandbox, with no real token inside it.
- [Slack](./slack.md): requests in Slack, and who can start work there.
- [Spaces](./spaces.md): named, shared homes for related work, each with a
  Lead that starts and steers the work in it.
- [Tools](./tools.md): what the model can call, and what each call returns.
