# Google plugin

Junior acts as its own Google Workspace account, never with the credentials
of the people it helps. The plugin owns Calendar scheduling, Meet transcript
reads, and Docs, Sheets, and Slides reads. Gmail and Drive writes are out of
scope. Tracking issue: getsentry/junior#2063.

## Credentials

- A Junior admin connects the account out of band, from the dashboard Admin
  page or `junior google connect`. Slack never shows the sign-in link, the
  code, or a token.
- Sign-in must name the configured account and grant every required scope.
  If a check fails, revoke the grant and store nothing.
- On `invalid_grant`, delete the stored refresh token and ask an admin to
  connect again.
- Access tokens apply only to `www.googleapis.com` requests from this
  plugin's tools. `grantForEgress` denies sandbox commands and requests that
  match no declared operation, so `curl` cannot skip the tool rules.
- Add a scope only when a tool needs it.
- Without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
  `GOOGLE_WORKSPACE_ACCOUNT_EMAIL`, register no tools and no routes.

## Calendar

- Check and invite only people in the allowed domains. The default is the
  domain of the account email.
- Change or cancel only events that Junior organizes, and only for an invited
  requester.
- `findMeetingTimes` reads free/busy data and time zones only, not event
  titles or details. `listCalendarEvents` never returns descriptions.
- A retry of `createCalendarEvent` returns the same event and sends no second
  invite.

## Files and transcripts

- Drive sharing decides what Junior can read. Do not add a second access
  model in the tools.
- Cap each inline result at `MAX_CONTENT_CHARS`. Save the full transcript to
  the Conversation sandbox and return its path.
- `readMeetingTranscript` requires that Junior and the requester are both
  invited. It reads only Docs that the organizer owns and that were made
  after the meeting started. Do not match on titles.
- Mark transcript and file text as untrusted. Junior acts on it only when the
  requester or an Automation asks.

## Known gaps

- The refresh token is plain text in Postgres (getsentry/junior#2065).
- Anyone who can talk to Junior can read what the account can see.
