# @sentry/junior-google

Proof of concept. Junior uses its own Google Workspace account, such as
`junior@example.com`, to schedule meetings, read Meet transcripts, read
Google Docs, Sheets, and Slides that are shared with that account, and create
and edit Google Docs. Junior does
not use the Google credentials of the people it helps.

## Setup

1. In the Google Cloud project of the dashboard OAuth client, enable the
   Calendar, Docs, Drive, Sheets, and Slides APIs.
2. Use an **Internal** consent screen. Add the scopes
   `calendar.events.freebusy`, `calendar.events.readonly`,
   `calendar.events.owned`, `documents`, `drive.file`, and `drive.readonly`.
   After you add a scope, reconnect the account in step 7.
3. Add the redirect URIs
   `https://<junior host>/api/plugins/google/oauth/callback` and
   `http://127.0.0.1:8765/oauth/callback` (CLI).
4. Give the Junior account a Workspace license.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_WORKSPACE_ACCOUNT_EMAIL`, and optionally
   `GOOGLE_WORKSPACE_ALLOWED_DOMAINS`.
6. Run `junior upgrade`, then `junior admin grant <email>` for each admin.
7. Connect the account on **Admin → Google account** in the dashboard, or run
   `junior google connect`.

Anyone who can talk to Junior can read what the Junior account can see. Share
calendars and files with that account only when that is acceptable. Given a
link, Junior opens any Doc, Sheet, or Slides file shared with its account.
Search finds only files that any employee could already find in Drive, and
files shared with the requester by name. Files shared by link, or only with
other people or groups, never show up in search. Search also drops every file
that no account in `GOOGLE_WORKSPACE_ALLOWED_DOMAINS` owns. Shared-drive files
have no owner, so search shows them only when they are shared with the
requester by name. Search returns nothing for a requester outside those
domains.

The dashboard shows a card for a Doc, Sheet, Slides, or Calendar event link
only when the signed-in viewer can open it too. A file must name the
viewer's email as a reader, writer, or owner, be open to anyone with the
link, or be open to the viewer's domain and owned in that domain. Access
through a Google group gets no card. An event must be on the Junior
account's calendar, with the viewer as its organizer, creator, or a guest.
A file card shows the title, type, owner, and modified time. An event card
shows the title and time. Cards never show content or guests.

Junior edits a Doc only for a requester who can edit it through their own
email, their domain, or an editable link. Access through a Google group is not
checked. Anyone who can talk to Junior can read a Doc that Junior edits, if
they give Junior its link. Junior makes the requester the owner of a Doc it
creates, then removes its own access. Google emails the requester about the
new ownership. Junior cannot read or edit that Doc again unless the requester
shares it back. This only works for requesters in the same Workspace
organization as Junior's account.

Each edit of an existing Doc needs the `revision_id` that `readGoogleDoc` or
the last edit returned. If someone changed the Doc after that, the edit is
refused, so Junior never changes text that it did not read.

Plugin setup: https://junior.sentry.dev/extend/
