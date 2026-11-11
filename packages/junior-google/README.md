# @sentry/junior-google

Proof of concept. Junior uses its own Google Workspace account, such as
`junior@example.com`, to schedule meetings, read Meet transcripts, and read
Google Docs, Sheets, and Slides that are shared with that account. Junior does
not use the Google credentials of the people it helps.

## Setup

1. In the Google Cloud project of the dashboard OAuth client, enable the
   Calendar, Drive, Sheets, and Slides APIs.
2. Use an **Internal** consent screen. Add the scopes
   `calendar.events.freebusy`, `calendar.events.readonly`,
   `calendar.events.owned`, and `drive.readonly`.
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

Junior reads a Doc, Sheet, or Slides file, or its comments, only for a
requester who can open it through their own email, their domain, or a link.
Search leaves out the other files. Junior can check this only on files that
its account can share, because Google shows a file's permissions only to
people who can share it. Share files with the Junior account as an editor.
Junior refuses files that it can only view. Access through a Google group is
not checked. Meet transcripts keep their own check: the requester must be
invited to the meeting.

Calendar reads are not checked this way. Anyone who can talk to Junior can
read the calendars that the Junior account can see. Share calendars with that
account only when that is acceptable.

Plugin setup: https://junior.sentry.dev/extend/
