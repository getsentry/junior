---
name: linear
description: Manage Linear issues through Linear's hosted MCP server. Use when users ask to create a Linear ticket, update a Linear issue, add a Linear comment, move work between states, assign work, or look up Linear issue, team, or project details from Slack context.
---

# Linear Operations

Use this skill for Linear issue workflows in the harness.

## Reference loading

Load references conditionally based on the request:

| Need                                             | Read                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Any Linear operation                             | [references/api-surface.md](references/api-surface.md)                                 |
| Create, update, comment, assign, or state change | [references/common-use-cases.md](references/common-use-cases.md)                       |
| Auth issues, ambiguity, or tool failures         | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Workflow

1. Resolve the operation and target:

- Determine whether the request is read-only inspection, issue creation, comment, field update, assignment, or state transition.
- Prefer explicit issue identifiers, issue URLs, project names, team names, or assignees when the user provides them.
- If the request refers to an existing Linear item indirectly, inspect the current thread context for the previously mentioned issue key or URL before asking the user to restate it.
- Ask one concise follow-up only when a write is blocked by real ambiguity, such as multiple plausible teams or no clear target issue.

2. Use the active Linear MCP tools:

- `loadSkill` returns `available_tools` for this skill, including the exact `tool_name` values and input schemas exposed in this turn.
- Call those exact tool names directly. Use `searchTools` only if you need to rediscover or filter the active Linear tools later in the turn.
- Prefer a short read/search step before mutating when you need to confirm the existing issue, team, project, or workflow state.
- For issue creation, ground the ticket in the actual engineering problem:
  - summarize the problem, impact, and expected outcome from the Slack thread
  - preserve relevant URLs already present in the conversation, such as Sentry, GitHub, docs, or reproduction links
  - translate Slack-specific phrasing into product or engineering language
  - remove usernames, channel names, slash commands, and session chatter unless the user explicitly wants them preserved
- For updates, prefer partial changes over full rewrites. Fetch current issue state first if the mutation could overwrite structured fields or duplicate an existing comment.
- When the thread clearly indicates the work originated in Slack, mention that succinctly in the Linear ticket or comment if it improves provenance, but do not paste large thread transcripts.

3. Report the result:

- Return the canonical Linear issue URL or key and summarize what changed.
- Keep routine tool chatter silent. Do not narrate each MCP search or mutation step.

## Guardrails

- Reuse or update an existing Linear issue when it is clearly the same work instead of creating a duplicate.
- Do not present guesses as facts. If the thread leaves an important detail uncertain, label it as an assumption in the Linear content.
- Prefer concise, durable ticket text over verbatim Slack quotes or long transcript dumps.
- If Linear authorization is required, let the MCP OAuth flow pause and resume the thread automatically instead of asking the user to handle credentials manually.
