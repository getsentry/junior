# SQL Identities

`junior_users` stores person-level data. Provider accounts live in
`junior_identities` and link to a user only through a verified normalized email.

`junior_users.display_name` is the canonical name for a linked person. The first
non-empty name observed while creating or linking the user is retained; later
provider-specific names do not replace it. Conversation actors use that user
name when present and otherwise fall back to
`junior_identities.display_name`.

Provider handles and subject IDs always remain identity-scoped. Display names
are presentation data and must never be used to link identities or grant
authority.

## Person lookup and mentions

`resolve.ts` backs `slackUserLookup`. It turns a person reference into a
workspace Slack user for the active team. Lookup modes are Slack user id,
email, display name/handle query, and GitHub username. Exact stored matches win
first. Live Slack profile lookup or name search fills gaps and upserts observed
identities. Ambiguous or missing matches return candidates or `not_found` —
callers must not guess.

`slackUserLookup` returns profile fields plus a delivery-ready `mention` token
(`<@U…>`) when the match is unique. Slack reply normalization also rewrites bare
`@U…` ids and `[[mention:U…]]` placeholders at send time.
