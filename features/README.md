# Features

Each file states what one major system must do for its users, and the rules
users rely on. Teammates read it to learn the intent. Agents read it before
they change the system. The `feature-docs` skill writes these files, and the
`maintain-feature-docs` skill checks them against the code.

## File contract

Each file has an H1 title and one paragraph that says what the user gets.
Then it has exactly these H2 sections, in this order:

1. `Behaviors`: one bullet for each behavior. Start with a short ID in
   backticks. Say what the user does and what the user then sees.
2. `Entry points`: each place where a user reaches the system, by its
   visible name.
3. `Rules`: invariants that users rely on, and what the system is not.

Name only user actions, visible names, required access, and outcomes that a
user can see. Leave out source paths, symbols, schemas, design, history, and
rollout notes. Use the words in `../TERMINOLOGY.md`.

Behavior IDs are stable. Evals, tests, and PRs refer to a behavior as
`<file>#<id>`, for example `automations#create`.

## Features

- [Automations](./automations.md): saved instructions that Junior runs later.
- [GitHub](./github.md): code, pull requests, and issues in GitHub repos.
- [Review desk](./review-desk.md): work that waits for a person, labeled
  "Inbox" in the dashboard.
