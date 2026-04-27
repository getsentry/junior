# API Surface

Use this reference for any Linear operation.

## Provider capabilities

Linear's hosted MCP server is intended for authenticated remote MCP access to Linear data.
The current public docs describe support for finding, creating, and updating objects such as issues, projects, and comments.

## Linear issue model constraints

- Every issue belongs to exactly one team.
- A new issue requires a title and a status; all other properties are optional.
- Workflow states are team-specific. The common default order is `Backlog > Todo > In Progress > Done > Canceled`, but teams can customize names and ordering.
- Priority is optional and limited to `low`, `medium`, `high`, or `urgent`.
- Labels can be workspace-scoped or team-scoped.
- Estimates are optional and team-configured.

## Operation patterns

| Intent               | Minimum tool pattern                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Inspect an issue     | Resolve the issue by key, URL, or search query, then fetch current state before answering.                                   |
| Create an issue      | Confirm the team first, then create the issue with grounded title/body content and only the optional fields you can justify. |
| Update fields        | Fetch current issue state first, then mutate only the requested fields.                                                      |
| Add a comment        | Resolve the exact issue first, then add a concise comment with durable links and next steps.                                 |
| Move state or assign | Read the current issue and team workflow first when state, workflow, or assignee ambiguity could cause the wrong mutation.   |
| Check for duplicates | Search for an existing matching issue before opening a new one when the request appears related to ongoing work.             |

## Content expectations

- Translate Slack-thread wording into stable product or engineering language.
- Preserve material links already present in the conversation, such as Sentry, GitHub, docs, repro, or dashboard URLs.
- Keep provenance concise. Mention Slack origin only when it helps future readers understand why the issue exists.
- Treat team, status, labels, estimate, cycle, and project as structured properties, not prose-only body content, when those fields are available and the values are actually known.
- Prefer partial updates over full rewrites.
- Label assumptions clearly when the thread leaves important details uncertain.
