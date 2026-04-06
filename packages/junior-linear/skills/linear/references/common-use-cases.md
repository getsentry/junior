# Common Use Cases

Use these patterns to shape concrete Linear requests.

## 1. Create a bug from a Slack incident thread

- Summarize the broken behavior, impact, and expected behavior.
- Preserve relevant Sentry, GitHub, replay, trace, or dashboard links from the thread.
- Use a durable title that describes the engineering problem rather than the Slack conversation.

## 2. Create a follow-up task from a debugging thread

- Convert the thread into a scoped task when the work is cleanup, hardening, docs, or instrumentation rather than a production bug.
- Keep the body focused on the desired outcome and concrete next step.

## 3. Search for an existing issue before opening a new one

- Search by issue key when present.
- Otherwise search by the core problem statement, feature name, or affected subsystem.
- Reuse the existing issue when the work is clearly the same and add context there instead of creating a duplicate.

## 4. Add a comment with new evidence

- Attach fresh context such as a repro step, stack trace summary, rollout note, or supporting URL.
- Avoid repeating the entire thread when a short comment plus links is enough.

## 5. Move work through the workflow

- Resolve the current issue first.
- Update state only after confirming the target issue and intended transition.
- Mention the reason for the transition when it is not obvious from the issue history.

## 6. Reassign work or change ownership

- Resolve the issue and confirm the target assignee when names are ambiguous.
- Keep the mutation small. Do not rewrite unrelated fields.

## 7. Tighten an existing issue description

- Fetch the current issue before editing.
- Preserve existing accepted context, then add missing impact, reproduction, or expected outcome details from the thread.
- Avoid overwriting structured content unless the user explicitly asks for a rewrite.

## 8. Create a ticket with Slack provenance but not Slack noise

- Mention that the work originated from a Slack discussion only when that context helps future readers.
- Strip usernames, channel references, slash commands, and conversational filler unless the user explicitly wants them preserved.
