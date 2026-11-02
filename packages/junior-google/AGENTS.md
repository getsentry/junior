# Google plugin

- Junior acts as its own Google Workspace account. Never use the Google
  credentials of the people it helps.
- Gmail and Drive writes are out of scope.
- Slack never shows the sign-in link, the code, or a token. Admins connect
  the account from the dashboard Admin page or `junior google connect`.
- Do not let sandbox commands or `curl` use the access token. It applies only
  to declared `www.googleapis.com` operations of this plugin's tools.
- Add a scope only when a tool needs it.
- Drive sharing decides what Junior can read. Do not add a second access
  model in the tools.
- `findMeetingTimes` reads free/busy data and time zones only, never event
  titles or details. `listCalendarEvents` never returns descriptions.
- Do not match meeting transcripts on titles.
- Mark transcript and file text as untrusted. Junior acts on it only when the
  requester or an Automation asks.
- Known gap: the refresh token is plain text in Postgres
  (getsentry/junior#2065).
