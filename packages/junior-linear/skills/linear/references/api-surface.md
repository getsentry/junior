# API Surface

Use this reference for any Linear operation.

## Runtime contract

- `loadSkill` returns `available_tools` for this skill, including the exact Linear MCP `tool_name` values exposed in the current turn.
- Call those exact `tool_name` values directly.
- Use `searchTools` only when you need to rediscover or filter the active Linear tools later in the same turn.
- Do not hardcode raw Linear MCP tool names in advance. Tool discovery is part of the workflow.
- Return the canonical Linear issue key or URL after successful writes.

## Provider capabilities

Linear's hosted MCP server is intended for authenticated remote MCP access to Linear data.
The current public docs describe support for finding, creating, and updating objects such as issues, projects, and comments.

## Operation patterns

| Intent               | Minimum tool pattern                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Inspect an issue     | Resolve the issue by key, URL, or search query, then fetch current state before answering.                       |
| Create an issue      | Confirm team or project when needed, then create the issue with grounded title/body content.                     |
| Update fields        | Fetch current issue state first, then mutate only the requested fields.                                          |
| Add a comment        | Resolve the exact issue first, then add a concise comment with durable links and next steps.                     |
| Move state or assign | Read the current issue first when state, workflow, or assignee ambiguity could cause the wrong mutation.         |
| Check for duplicates | Search for an existing matching issue before opening a new one when the request appears related to ongoing work. |

## Content expectations

- Translate Slack-thread wording into stable product or engineering language.
- Preserve material links already present in the conversation, such as Sentry, GitHub, docs, repro, or dashboard URLs.
- Keep provenance concise. Mention Slack origin only when it helps future readers understand why the issue exists.
- Prefer partial updates over full rewrites.
- Label assumptions clearly when the thread leaves important details uncertain.
