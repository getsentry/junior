# Feature doc examples

The content in these examples is made up. Only the shape is real.

## Good file

```md
# Notes

A user saves short notes in Slack and finds them later from Slack or the
dashboard.

## Behaviors

- `save` A user asks Junior to save a note. Junior replies with the note title.
- `find` A user asks for notes about a topic. Junior lists the matching titles.
- `delete` The author deletes a note. It no longer shows in any list.

## Entry points

- Slack: ask Junior in a channel or DM.
- Dashboard: Notes.

## Rules

- Only the author and Admins can delete a note.
- A note is not a Review item. Nobody is asked to act on it.
```

## Behavior that depends on access

State the access in the line. Do not add a section for it.

```md
- `connect` A user without a GitHub connection asks for a private repo.
  Junior asks them to connect, then continues the same request.
```

## Implementation leak, and the fix

Bad: names code, explains how, adds history, and uses two lines for one
behavior.

```md
- `save` `saveNote()` writes a row to `notes` through the Drizzle builder.
- Saving was moved to a queue in v0.40 so that it survives timeouts.
- Saving can take a few seconds because of the queue.
```

Fixed: one bullet that states what the user sees.

```md
- `save` A user asks Junior to save a note. Junior replies with the note title.
```
