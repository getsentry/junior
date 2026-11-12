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

Google Meet shares transcripts and Gemini notes with every invitee, Junior's
account too, and names them in the organizer's language. The file tools refuse
any file whose title mentions Gemini or a transcript in a common language. Only
`readMeetingTranscript` reads Meet records, and only for people invited to the
meeting. The title match is a conservative exclusion: it also refuses some
ordinary files, and it misses a record renamed to avoid these words.

Plugin setup: https://junior.sentry.dev/extend/
