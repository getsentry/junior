# SQL Identities

`junior_users` stores person-level data. Provider accounts live in
`junior_identities` and link to a user only through a verified normalized email.

`junior_users.display_name` is the canonical name for a linked person. The first
non-empty name observed while creating or linking the user is retained; later
provider-specific names do not replace it. Conversation actors use that user
name when present and otherwise fall back to
`junior_identities.display_name`.

`junior_users.timezone` is the person's IANA timezone. `identities/timezone.ts`
picks a person's timezone: their Slack profile `tz`, then this column, then
`JUNIOR_TIMEZONE` (default `America/Los_Angeles`). It saves a valid Slack
timezone to this column. The scheduler and plugin tools use it, through
`ctx.users.resolveTimezone()`. See the Timezones section in
`chat/scheduled-automations/README.md`.

## OAuth Account Links

When a person connects a provider account, the OAuth callback links the
provider identity to a user. The plugin `resolveOAuthAccount` hook must return
the account. The person must start the connection from Slack or the web UI.

- The user of the person who started the connection wins. For Slack, this is
  the user of the Slack identity. For the web UI, this is the user of the
  verified dashboard email.
- A plugin can return `verifiedEmails` that the provider verified for the
  account. When the person has no user, the account links to the one user
  whose primary email is in the list. When more than one user matches, the
  account does not link.
- A verified email that matches the linked user is saved on the provider
  identity. Other verified emails are not saved. Verified emails are never
  stored with the OAuth tokens.
- Linking is best effort. A failure keeps the stored tokens and logs
  `oauth.callback.identity_link.failed`.

Provider handles and subject IDs always remain identity-scoped. Display names
are presentation data and must never be used to link identities or grant
authority.
