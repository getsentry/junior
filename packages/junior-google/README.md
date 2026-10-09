# @sentry/junior-google

Proof of concept. Junior acts as its own Google Workspace account, for example
`junior@sentry.io`. Junior does not use the Google credentials of the people it
helps. Tracking issue: getsentry/junior#2063.

This version supports Calendar only. Drive and Gmail are out of scope.

## Surfaces

- `findMeetingTimes` finds times when every attendee is free. It reads
  free/busy data only. It never reads event titles or details.
- `createCalendarEvent` creates an event on Junior's own calendar. It sends
  invites and can add a Google Meet link. A retry of the same tool call returns
  the same event. It does not create a second invite.
- `listCalendarEvents` reads the events on one colleague's calendar. It shows
  only what the calendar's Google sharing settings let Junior's account see.
  A calendar shared as free/busy only shows busy blocks without titles. It
  never returns event descriptions.
- `updateCalendarEvent` changes the title, description, time, or attendees of
  an event that Junior organizes. Google emails the attendees about the
  change. Only people invited to the event can ask for a change.
- `createCalendarEvent` and `updateCalendarEvent` save a Calendar event
  annotation on the Conversation. Junior shows its card with the next reply.
  The card shows the title, time, and attendees, and links to the event. A
  change to an event replaces its card.
- The **Google account** page on the dashboard Admin page shows whether the
  account is connected. Its Connect button starts Google sign-in.
- `junior google connect` and `junior google status` are the operator CLI.

## Authentication

A Junior admin connects the account one time, out of band. Slack never shows
the sign-in link, the authorization code, or any token. Junior admins are
managed with `junior admin grant <email>`. This plugin has no admin list of its
own.

1. An admin opens **Admin → Google account** in the dashboard and selects
   **Connect**, or runs `junior google connect`.
2. Google sign-in opens with PKCE and a single-use state value.
3. The admin signs in as the configured account, not as themselves.
4. Junior checks that the identity token names the configured account. It also
   checks that Google granted every Calendar scope. If a check fails, Junior
   revokes the grant and stores nothing.
5. Junior stores the refresh token in the `junior_google_accounts` table.

At runtime, the `issueCredential` hook exchanges the refresh token for a
one-hour access token. Junior applies that token only to `www.googleapis.com`
requests from this plugin's tools. The `grantForEgress` hook denies sandbox
commands and any request that does not match a declared operation. Thus the
model cannot use `curl` to read Junior's calendar and skip the tool rules.

If Google rejects the refresh token (`invalid_grant`), Junior deletes it. The
tools then report that an admin must connect the account again. If the stored
grant does not have every scope the current tools need, the tools also ask an
admin to reconnect.

## Rules in code

- Junior checks and invites only people in the allowed domains. By default,
  the allowed domain is the domain of the account email.
- Junior adds the requester to the attendees when it knows their email.
- Junior changes only events that it organizes, and only for a requester who
  is invited to the event.
- Calendar scopes are `calendar.events.freebusy`, `calendar.events.readonly`,
  and `calendar.events.owned`. Junior also requests `openid email` to verify
  the account during sign-in.

## Setup

The plugin uses the same Google OAuth client as dashboard sign-in. Each
sign-in requests only its own scopes, so dashboard sign-in still asks only for
identity.

1. In the Google Cloud project of the dashboard OAuth client, enable the
   Google Calendar API.
2. On the OAuth consent screen, use user type **Internal** and add the
   Calendar scopes above.
3. On the OAuth client, add these redirect URIs:
   - `https://<junior host>/api/plugins/google/oauth/callback`
   - `http://127.0.0.1:8765/oauth/callback`, for the CLI. Use another port with
     `junior google connect --port`.
4. Give the Junior account a Workspace license.
5. Set these environment variables on the deployment:

| Variable                           | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `GOOGLE_CLIENT_ID`                 | OAuth client id, shared with dashboard sign-in  |
| `GOOGLE_CLIENT_SECRET`             | OAuth client secret                             |
| `GOOGLE_WORKSPACE_ACCOUNT_EMAIL`   | The account Junior acts as                      |
| `GOOGLE_WORKSPACE_ALLOWED_DOMAINS` | Optional comma-separated domains to schedule in |

The plugin registers no tools and no sign-in routes until the first three
variables are set. The Admin page shows **Not configured** until then.

6. Run `junior upgrade` to create the table.
7. Run `junior admin grant <email>` for each person who may connect the account.
8. Connect the account on **Admin → Google account**, or run
   `junior google connect` with the deployment database configured.

## Known gaps

- The refresh token is stored in plain text in Postgres. Encryption at rest is
  tracked in getsentry/junior#2065.
- Free/busy and event details show only what the company's calendar sharing
  default allows. Calendars that Junior cannot see appear in `unavailable`
  for `findMeetingTimes`, and as `visible: false` for `listCalendarEvents`.
- Anyone who can talk to Junior can ask it to read a colleague's calendar.
  Junior returns what its own account can see, so set the sharing default
  with that in mind.
- No disconnect command. To revoke access, remove the app grant from the
  Junior account in Google.
