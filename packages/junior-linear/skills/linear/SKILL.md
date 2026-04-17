---
name: linear
description: Manage Linear issues through Linear's hosted MCP server. Use when users ask to create a Linear ticket, update a Linear issue, add a Linear comment, move work between states, assign work, or look up Linear issue, team, or project details from Slack context.
uses-config: linear.team linear.project
---

# Linear Operations

Use this skill for Linear issue workflows in the harness.

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

2. Use the active Linear MCP tools:

- `loadSkill` returns `available_tools` for this skill, including the exact `tool_name` values and input schemas exposed in this turn.
- Call those exact tool names directly. Use `searchTools` only if you need to rediscover or filter the active Linear tools later in the turn.
- Prefer a short read/search step before mutating when you need to confirm the existing issue, team, project, or workflow state.
- For create/update operations, classify the work as a `bug`, `feature`, or `task` and shape the title/body accordingly.
- For issue creation, ground the ticket in the actual engineering problem:
  - use a short descriptive title for bugs, short imperative title for tasks and features
  - summarize the problem and impact; include expected outcome only when the thread states one
  - mention who raised the issue when clear from the thread
  - attach screenshots from the thread as image links when present
  - preserve relevant URLs inline (Sentry, GitHub, docs, reproduction links) — do not dump a link list
  - prefer flat bullet lists over headed sections for simple issues
  - translate Slack-specific phrasing into product or engineering language
  - remove channel names, slash commands, and session chatter unless the user explicitly wants them preserved
- When setting optional fields, stay literal:
  - use the team's actual workflow states instead of assuming generic names like `Todo` or `In Progress`
  - use only Linear's standard priority levels: `low`, `medium`, `high`, `urgent`
  - set project, labels, cycle, estimate, or assignee only when the user asked for them or the thread makes them clear
- For updates, prefer partial changes over full rewrites. Fetch current issue state first if the mutation could overwrite structured fields or duplicate an existing comment.
- Check for duplicates silently before creating a new issue when the request appears related to existing work.
- When the thread clearly indicates the work originated in Slack, mention that succinctly in the Linear ticket or comment if it improves provenance, but do not paste large thread transcripts.

3. Report the result:

- Return the canonical Linear issue URL or key and summarize what changed.
- Report issue type when you created a new issue and it materially clarifies the outcome.
- Keep routine tool chatter silent. Do not narrate each MCP search or mutation step.

## Guardrails

- Reuse or update an existing Linear issue when it is clearly the same work instead of creating a duplicate.
- Do not present guesses as facts. If the thread leaves an important detail uncertain, label it as an assumption in the Linear content.
- Prefer concise, durable ticket text over verbatim Slack quotes or long transcript dumps.
- Do not invent team-specific workflow names, labels, or estimate values without first confirming they exist.
- If Linear authorization is required, let the MCP OAuth flow pause and resume the thread automatically instead of asking the user to handle credentials manually.
