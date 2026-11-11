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
calendars and files with that account only when that is acceptable. Junior
edits a Doc only for a requester who can edit it through their own email,
their domain, or an editable link. Access through a Google group is not
checked. Anyone who can talk to Junior can read a Doc that Junior edits, if
they give Junior its link. Junior makes the requester the owner of a Doc it creates, then
removes its own access. Google emails the requester about the new ownership.
Junior cannot read or edit that Doc again unless the requester shares it back.
This only works for requesters in the same Workspace organization as Junior's
account.

Plugin setup: https://junior.sentry.dev/extend/
