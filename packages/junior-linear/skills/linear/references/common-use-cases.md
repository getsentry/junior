# Common Use Cases

Use these patterns to shape concrete Linear requests.

## 1. Create a bug from a Slack incident thread

- Summarize the broken behavior and impact. Include expected behavior only if stated in the thread.
- Resolve the right team before creating because Linear issues cannot be created without one.
- If the thread does not name a destination, use `linear.team` and `linear.project` channel defaults before asking a follow-up.
- Preserve relevant Sentry, GitHub, replay, trace, or dashboard links from the thread.
- Use a durable title that describes the engineering problem rather than the Slack conversation.

## 2. Create a follow-up task from a debugging thread

- Convert the thread into a scoped task when the work is cleanup, hardening, docs, or instrumentation rather than a production bug.
- Keep the body focused on scope and concrete next step. Include desired outcome only if stated in the thread.
- Set project, cycle, or assignee only when the destination is already clear from the thread.

## 3. Search for an existing issue before opening a new one

- Search by issue key when present.
- Otherwise search by the core problem statement, feature name, or affected subsystem.
- Reuse the existing issue when the work is clearly the same and add context there instead of creating a duplicate.

## 4. Add a comment with new evidence

- Attach fresh context such as a repro step, stack trace summary, rollout note, or supporting URL.
- Avoid repeating the entire thread when a short comment plus links is enough.

## 5. Move work through the workflow

- Resolve the current issue first.
- Read the team's actual workflow states first if the requested move uses category language like `started`, `done`, or `canceled` rather than an exact state name.
- Update state only after confirming the target issue and intended transition.
- Mention the reason for the transition when it is not obvious from the issue history.

## 6. Reassign work or change ownership

- Resolve the issue and confirm the target assignee when names are ambiguous.
- Keep the mutation small. Do not rewrite unrelated fields.
- Preserve the current project, labels, and workflow state unless the user asked to change them too.

## 7. Tighten an existing issue description

- Fetch the current issue before editing.
- Preserve existing accepted context, then add missing impact, reproduction, or expected outcome details from the thread.
- Avoid overwriting structured content unless the user explicitly asks for a rewrite.

## 8. Create a ticket with Slack provenance but not Slack noise

- Mention that the work originated from a Slack discussion only when that context helps future readers.
- Mention who raised the issue when clear from the thread (e.g. "Reported by Jane from the support team").
- Strip channel references, slash commands, and conversational filler unless the user explicitly wants them preserved.

## 9. Set priority, labels, or estimate from thread context

- Use only Linear's standard priority levels: `low`, `medium`, `high`, `urgent`.
- Reuse existing labels when the thread makes the intended label clear; do not invent lookalike labels casually.
- Set an estimate only when the value is explicit or already established in the team context, since estimate scales are team-configured.

## 10. Mark work as a duplicate

- Search for the canonical destination issue first.
- If the MCP tool supports duplicate relationships directly, use that instead of only posting a comment.
- If the workflow exposes a dedicated duplicate status, prefer it; otherwise expect duplicate handling to land in the team's canceled category.

## 11. When a user asks to set channel defaults for a Linear-heavy Slack thread

- Use `jr-rpc config set linear.team <team name or key>` when the user explicitly asks to store a team default and the channel consistently routes new work to the same team.
- Use `jr-rpc config set linear.project <project name>` when the user explicitly asks to store a project default and the channel mostly tracks one project.
- Treat both defaults as optional. Explicit user input wins whenever a request names a different team or project.
