# Design

Each file states the intent of one major system: the goals it must meet,
where users reach it, and the rules users rely on. Teammates read it to learn
why the system works the way it does. Agents read it before they change the
system. The `create-design-docs` skill writes these files, and the
`maintain-design-docs` skill checks the product against them. Both skills
live in getsentry/junior-prod.

## File contract

Each file has an H1 title and one paragraph that says what the user gets.
Then it has these H2 sections, in this order:

1. `Intent`: the goals that the system must meet, and why. Each goal
   decides between real options, such as "runs work with no person
   present".
2. `Entry points`: each place where a user reaches the system, by its
   visible name.
3. `Rules`: limits that users rely on, such as who can act, and what the
   system is not.
4. `Gaps`: only when the product does not meet a goal or a rule yet. Say
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

- [Automations](./automations.md): saved instructions that Junior runs later.
- [GitHub](./github.md): code, pull requests, and issues in GitHub repos.
- [Review desk](./review-desk.md): work that waits for a person, labeled
  "Inbox" in the dashboard.
- [Sandbox credentials](./sandbox-credentials.md): provider access for
  commands in a Sandbox, with no real token inside it.
