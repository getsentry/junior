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

Provider handles and subject IDs always remain identity-scoped. Display names
are presentation data and must never be used to link identities or grant
authority.
