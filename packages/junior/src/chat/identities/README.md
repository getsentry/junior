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

## Profile Photos

`junior_identities.avatar_url` is the profile photo URL from the provider.
Only the native identities save it. `identities/avatar.ts` owns the rules.

- A Slack Turn saves the Slack photo of its Actor (`chat/slack/avatar.ts`), at
  most once a day for each person. Junior saves only a photo that the person
  set. Slack's default photo is not saved, so the Google photo can show
  instead.
- Each Google sign-in saves the Google `picture` claim.
- Each save replaces the old photo. No photo clears it. A failed Slack lookup
  keeps the old photo.
- Junior saves and fetches only HTTPS URLs on the photo hosts of the provider.
- `readUserAvatarUrls()` picks one photo for each user: the Slack photo, then
  the Google photo. Conversation participants, automation creators, and
  `/api/me` return it as a Junior API path, never as the provider URL.
- `GET /api/people/avatars/:identityId` serves the photo. Junior fetches it
  from the provider once and keeps it in the state cache for a day. Browsers
  never contact Slack or Google, and they never see the provider URL.

## Actor Identities

`actor.ts` resolves each runtime Actor to one Identity id.
`resolveActorIdentityId` saves the Identity and returns its id.
`findActorIdentityId` only reads. The Conversation store, OAuth, the viewer,
and message events use these functions, so they find the same Identity for
the same person. The key for each Actor is private to `actor.ts`.

- A Slack Actor is the Slack Identity in its workspace.
- A web Actor is the `junior` Identity keyed by its verified email.
- Every system Actor and every local Actor is the one system Identity: kind
  `system`, provider `junior`, an empty tenant, and subject `system`. The
  system Actor name is provenance. It is not part of the key.

A Conversation write without an Actor still uses a legacy system Identity
from its Source, with the subject `scheduler`, `local-cli`, or `event`.

## Native Identities

Core owns two identity providers: `slack` and `google`. Other checks trust
these identities, so only core links them. `isNativeIdentityProvider()` in
`identity.ts` lists them.

- A Slack identity has the Slack team ID as its tenant and the Slack user ID as
  its subject.
- A Google identity has an empty tenant and the Google OIDC `sub` as its
  subject. Each dashboard Google sign-in saves it with the verified Google
  email and sets `signed_in_at`. One Google account is
  one row, so every feature that reads the `google` identity sees the same
  account.
- The Google Workspace plugin is not a Google identity. It stores Junior's own
  Workspace account in its own table.

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
- A plugin OAuth account never links under a native identity provider name.
  The tokens are still stored.
- Linking is best effort. A failure keeps the stored tokens and logs
  `oauth.callback.identity_link.failed`.

Provider handles and subject IDs always remain identity-scoped. Display names
are presentation data and must never be used to link identities or grant
authority.

## Allowed Domains

`chat/sign-in/allowlist.ts` owns one list of allowed domains for Slack and the
dashboard. An empty list allows every domain.

- Slack ingress starts a Turn from a mention or DM only when the email of the
  author's Slack profile is on an allowed domain
  (`chat/ingress/slack-allowed-domain.ts`).
- `chat/sign-in/auth.ts` owns the one Better Auth instance of the dashboard. It
  accepts a Google sign-in only when the verified `hd` claim is an allowed
  domain. After each Google callback, a Better Auth hook saves the Google
  identity.
