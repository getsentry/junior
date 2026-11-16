---
name: feature-docs
description: Write or update the intent docs in `features/`, one file per major Junior system (such as Automations, GitHub, or the Review desk), that state the intended user behavior and the rules users rely on. Use when asked to document what a feature should do, add or edit a `features/*.md` file, or when a change adds, removes, or changes behavior that a user can see in a system. Do not use for public product docs in `packages/docs` (public-docs), policies, code comments, implementation plans, or auditing every feature doc (maintain-feature-docs).
---

# Feature docs

A feature doc states what a system should do for its users. Teammates read it
to learn the intent. Agents read it before they change the system, and
`maintain-feature-docs` checks the system against it.

`features/README.md` owns the file contract. Read it first, and follow it
exactly.

## Workflow

1. **Find the owning file.** Use the index in `features/README.md`. Add a new
   file only for a system that users name and use as a unit, such as
   Automations or GitHub. Otherwise, add to the closest existing file.
2. **Write the intent first.** Get the goals from the requester, the PR,
   the linked issue, or the owner of the system. The code does not show
   intent. A goal decides between real options, and a reader can check the
   product against it. "Easy to use" is not a goal.
3. **Get behavior from evidence.** Read the source, tests, evals, and
   `packages/docs` pages to learn what the system does. When a behavior or
   rule does not meet a goal, add a `Gaps` bullet. Do not change the goal.
4. **Ask about unclear intent.** When you cannot tell whether a behavior is
   intended or a gap, ask the requester. In a PR, list each open intent
   question in the PR body. Planned work with no current goal goes in an
   `openspec/changes/` plan.
5. **Edit in place.** Replace a stale line. Do not append a line that
   repeats or qualifies a line that is already there. When a behavior goes
   away, delete its line.
6. **Test each line.** Keep a line only if a user can see it happen, or if a
   user is harmed when it changes. Cut all other lines.
7. **Keep IDs stable.** A new ID is short kebab-case and unique in its file.
   Change an ID only when the behavior that it names changes. Evals, tests,
   and PRs refer to IDs as `<file>#<id>`.
8. **Update the index.** Each file has one line in `features/README.md`.

## Line test

| Keep                                                 | Cut                                       |
| ---------------------------------------------------- | ----------------------------------------- |
| What the user does and what the user then sees       | How the system does it                    |
| Visible names: tabs, commands, tools users ask for   | Source paths, symbols, tables, schemas    |
| Access that a behavior needs (role, connection)      | Internal steps, retries, queues, stores   |
| Goals, and why they matter                           | History, rollout notes, and plans         |
| Rules users rely on, and what the system is not      | Rationale for one design choice           |
| One bullet per behavior                              | A second bullet that rewords the first    |

See `references/examples.md` for a good file, a goal that decides nothing,
a behavior that depends on access, and an implementation leak with its fix.

## Before you finish

- The file has only the H1, the paragraph, and the H2s from the contract, in
  order.
- Each goal in `Intent` came from a person or a source that states intent,
  not only from the code.
- Each behavior line has an ID and an outcome that a user can see.
- The words match `TERMINOLOGY.md`.
- No line repeats a line in a different feature file. Link to the owning
  file instead.
