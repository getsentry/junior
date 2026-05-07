---
name: linear
description: Manage Linear issues through Linear's hosted MCP server. Use when users ask to create a Linear ticket, update a Linear issue, add a Linear comment, move work between states, assign work, or look up Linear issue, team, or project details from Slack context.
---

# Linear Operations

Use this skill for Linear issue workflows.

## Reference loading

Load references conditionally based on the request:

| Need                                             | Read                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any Linear operation                             | [references/api-surface.md](references/api-surface.md)                                                                                                                                     |
| Create, update, comment, assign, or state change | [references/common-use-cases.md](references/common-use-cases.md), [references/issue-writing.md](references/issue-writing.md), [references/issue-examples.md](references/issue-examples.md) |
| Auth issues, ambiguity, or tool failures         | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                                                                                     |

## Workflow

1. Resolve the operation and target:

- Determine whether the request is read-only inspection, issue creation, comment, field update, assignment, or state transition.
- Prefer explicit issue identifiers, issue URLs, project names, team names, or assignees when the user provides them.
- When the user did not specify a destination, treat `linear.team` and `linear.project` conversation config as optional defaults. Explicit user input always wins over config.
- Only set or change `linear.team` and `linear.project` when the user explicitly asks to store a default for this conversation or channel.
- For issue creation, resolve the target team before drafting because every Linear issue belongs to a single team.
- If `linear.project` is configured, use it as the default project only when the request does not name a different project and the project fits the current task.
- If the request refers to an existing Linear item indirectly, inspect the current thread context for the previously mentioned issue key or URL before asking the user to restate it.
- Ask one concise follow-up only when a write is blocked after considering both explicit user input and any configured defaults, such as multiple plausible teams, no clear target issue, or no valid team for a new issue.

2. Prepare the Linear operation:

- Prefer a short read/search step before mutating when you need to confirm the existing issue, team, project, or workflow state.

3. Draft issue content (create or substantial rewrite):

Classify the work as `bug`, `feature`, or `task`. Shape the title and body per [references/issue-writing.md](references/issue-writing.md); calibrate depth via [references/issue-examples.md](references/issue-examples.md).

**Hard constraints — apply to every new issue:**

- Title ≤ 60 characters. Descriptive for bugs, imperative for tasks/features.
- Summary ≤ 3 sentences. Do not restate the title in the body.
- Prefer flat bullet lists over headed sections for simple issues.
- Generalize session framing — strip channel references, slash commands, Slack thread IDs, user @mentions, and transcript fragments; replace with the underlying engineering problem.
- Compress source material. Research notes, hypotheses, or transcripts become a short summary + scoped bullets — never paste raw investigation into the body.
- Do not add desired outcome, expected behavior, or acceptance criteria unless the thread explicitly requests them.
- When the request originated from a Slack thread or any on-behalf-of context, append a final line `Action taken on behalf of <name>.` using the action requester's real name. The action requester is the current `<requester>` or the person who explicitly asked you to create/update the issue, not necessarily the original reporter.

Attribute the reporter by name when clear from the thread (e.g. "Raised by Alice during incident triage"). If the reporter differs from the action requester, keep them separate with durable body text such as `Reported by Alice.` — do not reference Slack channels, threads, or conversation metadata. Attach screenshots from the thread as image links when present. Preserve relevant URLs (Sentry, GitHub, docs, repro links) inline — do not dump a link list.

4. Set optional Linear fields literally:

- Use the team's actual workflow states instead of generic names like `Todo` or `In Progress`.
- Use only Linear's standard priority levels: `low`, `medium`, `high`, `urgent`.
- Set project, labels, cycle, estimate, or assignee only when the user asked for them or the thread makes them clear.

5. Verify draft before mutating:

- Title length ≤ 60 characters.
- Delegated-action footer is the last line when applicable, using the action requester's real name, not the reporter's name unless they are the same person.
- No session framing remains (channel refs, slash commands, @mentions, Slack thread IDs).
- Body structure matches complexity — no empty sections, no restated title, no raw research dump.

If any gate fails, revise and re-check before calling the MCP create/update tool.

6. Execute:

- For updates, prefer partial changes over full rewrites. Fetch current issue state first if the mutation could overwrite structured fields or duplicate an existing comment.
- Check for duplicates silently before creating a new issue when the request appears related to existing work.

7. Report the result:

- Return the canonical Linear issue URL or key and what changed.
- Report issue type when you created a new issue and it materially clarifies the outcome.

## Guardrails

- Reuse or update an existing Linear issue when it is clearly the same work instead of creating a duplicate.
- Label uncertain details as assumptions in the Linear content when the thread leaves them unresolved.
- Prefer concise, durable ticket text over verbatim Slack quotes or long transcript dumps.
- Do not invent team-specific workflow names, labels, or estimate values without first confirming they exist.
