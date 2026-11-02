# Identities

- Link an Identity to a User only through a verified normalized email.
- Never use display names to link Identities or grant authority. Provider
  handles and subject ids stay scoped to one Identity.
- Do not put a timezone on the Actor (`timezone.ts`).
- Build Actor keys only in `actor.ts`. The system Actor name is provenance,
  not part of the key.

## Native Identities

- Only core links the native providers `slack` and `google`, because other
  checks trust them. A plugin OAuth account never links under a native
  provider name.
- The Google Workspace plugin account is not a Google Identity.

## OAuth Account Links

- The User of the person who started the connection wins. Without one, an
  account links only when exactly one User has a primary email in the plugin
  `verifiedEmails`.
- Save only a verified email that matches the linked User. Never store
  verified emails with OAuth tokens.
- Linking is best effort. A failure keeps the tokens.

## Profile Photos

- Save and fetch only HTTPS URLs on the provider photo hosts.
- Browsers never contact Slack or Google and never see the provider URL.

## Allowed Domains

- `chat/sign-in/allowlist.ts` is one list for Slack and the dashboard. An
  empty list allows every domain.
