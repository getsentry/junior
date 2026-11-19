# Google Workspace

A user asks Junior to schedule meetings, read Meet transcripts, and read or
edit Google Docs, Sheets, and Slides. Junior does this as its own Google
Workspace account, so the user connects nothing.

## Intent

- One connection serves every Google tool. An admin connects Junior's
  account once, and Calendar, Docs, Sheets, and Slides work from it.
- Junior never changes a file for a person who could not change it
  themselves. Junior's account can edit files that the requester cannot, and
  that access must not let a requester do more than they could do alone.
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
- Anyone who can talk to Junior can read a file that Junior's account can
  open, if they give Junior its link. Share files with that account only when
  that is acceptable.
- Search finds only files that any employee could find in Drive, or that are
  shared with the requester by name. It hides files that nobody in the
  allowed domains owns, and it finds nothing for a requester outside them.
- A file or event card shows only to a viewer who can open the file or is on
  the event.
- Only an admin connects Junior's account. A requester cannot connect it or
  use their own account instead.
