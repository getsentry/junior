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
calendars and files with that account only when that is acceptable.

## Email requests

Trial. People can send or forward email to the Junior account, or CC it, to
ask for work. For example: "Junior, find us 30 minutes next week." Junior
replies in the sender's Slack DM. It does not send email.

1. Add the `gmail.readonly` scope to the consent screen and enable the Gmail
   API.
2. Set `GOOGLE_WORKSPACE_EMAIL_REQUESTS=true`.
3. Connect the account again to grant Gmail access.

The heartbeat reads new inbox mail every minute. Junior uses an email only when
all of these are true:

- Google's `Authentication-Results` header shows DMARC pass for the From
  domain.
- The From domain is in `GOOGLE_WORKSPACE_ALLOWED_DOMAINS`.
- The From address is the primary email of a known User, and that User is a
  current Slack member whose Slack profile shows the same email.
- The email is not automated mail, a calendar reply, or mail from Junior.

Junior ignores all other email. Quoted and forwarded text goes to the agent as
external text, not as instructions.

Plugin setup: https://junior.sentry.dev/extend/
