# Google Workspace

A user asks Junior to schedule meetings, read Meet transcripts, and read or
edit Google Docs, Sheets, and Slides. Junior does this as its own Google
Workspace account, so the user connects nothing.

## Intent

- One connection serves every Google tool. An admin connects Junior's
  account once, and Calendar, Docs, Sheets, and Slides work from it.
- Junior never reads or changes a file for a person who could not read or
  change it themselves. Junior's account can open and edit files that the
  requester cannot, and that access must not let a requester do more than
  they could do alone.
- Junior acts as its own account and never uses the Google credentials of
  the people it helps.
- Google access goes only through the Google tools, which apply these rules.
  Commands in a Sandbox get no Google credential.

## Entry points

- Slack: ask Junior in a thread or DM, or paste a Docs, Sheets, Slides,
  Drive, or Calendar link.
- Dashboard: Admin, Google account, to connect Junior's account; file and
  event cards in Conversations.
- CLI: `junior google connect`.

## Rules

- Junior edits an existing Doc or presentation only when the requester can
  edit it through their own email, their domain, or a link that anyone can
  edit. Access through a Google group is not checked, so that request is
  refused.
- Junior refuses an edit when the file changed after Junior read it, so it
  never changes content that it did not see.
- Junior changes or cancels only events that it organizes, and only for a
  requester who is invited to the event.
- Junior checks availability for and invites only people in the allowed
  domains.
- A Doc that Junior creates goes to the requester as its owner. Junior keeps
  no access to it.
- Google gets a Sandbox image for a presentation from a private copy,
  through a download URL that expires within 5 minutes. The URL that the
  deck keeps opens nothing after that, even when the copy is not deleted.
  An install whose storage cannot sign reads inserts no Sandbox image.
- Junior reads a file or its comments only for a requester who can open it
  through their own email, their domain when that domain owns the file, or
  a link that anyone can open.
  Access through a Google group does not count.
- Junior tells a requester who cannot open a file nothing about it, not even
  its title or type.
- Search finds only files that any employee could find in Drive, or that are
  shared with the requester by name. It hides files that nobody in the
  allowed domains owns, and it finds nothing for a requester outside them.
- A file or event card shows only to a viewer who can open the file or is on
  the event.
- Only an admin connects Junior's account. A requester cannot connect it or
  use their own account instead.

## Gaps

- Junior reads a Meet transcript for any requester who is invited to the
  meeting, also when the requester cannot open the transcript Doc. This
  breaks "never reads or changes a file for a person who could not read or
  change it themselves" and "reads a file or its comments only for a
  requester who can open it".
