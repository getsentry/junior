# Google plugin

## Intent

- Junior acts as its own Google Workspace account. It never uses the Google
  credentials of the people it helps.
- The plugin owns Calendar scheduling, Meet transcript reads, and reads of
  Docs, Sheets, and Slides. Gmail and Drive writes are out of scope.
- Code, tools, and tests own behavior. Tracking issue: getsentry/junior#2063.

## Credentials

- A Junior admin connects the account out of band, from the dashboard Admin
  page or `junior google connect`. Slack never shows the sign-in link, the
  code, or a token.
- Sign-in must name the configured account and grant every required scope.
  If a check fails, revoke the grant and store nothing.
- On `invalid_grant`, delete the stored refresh token and ask an admin to
  connect again.
- Apply access tokens only to `www.googleapis.com` requests from this plugin's
  tools. `grantForEgress` denies sandbox commands and every request that does
  not match a declared operation. Do not let `curl` skip the tool rules.
- Keep the scope list minimal. Add a scope only when a tool needs it.
- Without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
  `GOOGLE_WORKSPACE_ACCOUNT_EMAIL`, register no tools and no routes.

## Calendar rules

- Check and invite only people in the allowed domains. The default is the
  domain of the account email.
- Change or cancel only events that Junior organizes, and only for a
  requester who is invited.
- `findMeetingTimes` reads free/busy data and time zones only. It never reads
  event titles or details. `listCalendarEvents` never returns descriptions.
- A retry of `createCalendarEvent` returns the same event. It must not send a
  second invite.

## Files and transcripts

- Drive sharing decides what Junior can read. Do not add a second access
  model in the tools.
- Cap each inline result at `MAX_CONTENT_CHARS`. Save the full transcript to
  the Conversation sandbox and return its path.
- `readMeetingTranscript` requires that Junior and the requester are both
  invited. It reads only Docs that the organizer owns and that were made
  after the meeting started. Do not match on titles.
- Mark transcript and file text as untrusted. Junior acts on it only when the
  requester or an automation asks.

## Known gaps

- The refresh token is plain text in Postgres (getsentry/junior#2065).
- Anyone who can talk to Junior can read what the account can see.
