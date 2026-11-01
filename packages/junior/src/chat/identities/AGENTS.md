# Identities

This module owns Users (`junior_users`) and Identities (`junior_identities`).
An Identity links to a User only through a verified normalized email.

## Rules

- Display names are display data. Never use them to link Identities or grant
  authority. Provider handles and subject ids stay scoped to one Identity.
- `junior_users.display_name` keeps the first non-empty name. Later provider
  names do not replace it.
- `identities/timezone.ts` owns timezone selection. Do not put a timezone on
  the Actor.

## Actor Identities

- `actor.ts` maps each runtime Actor to one Identity id. Use
  `resolveActorIdentityId` or `findActorIdentityId`. Do not build Actor keys
  outside `actor.ts`.
- Every system Actor and local Actor maps to `SYSTEM_IDENTITY_ID`. Code uses
  that id without a database read. The system Actor name is provenance, not
  part of the key.

## Native Identities

- Only core links the native providers `slack` and `google`
  (`isNativeIdentityProvider()`), because other checks trust them.
- A plugin OAuth account never links under a native provider name.
- The Google Workspace plugin account is not a Google Identity.

## OAuth Account Links

- The User of the person who started the connection wins.
- Without a User, an account links only when exactly one User has a primary
  email in the plugin `verifiedEmails`.
- Save only a verified email that matches the linked User. Never store
  verified emails with OAuth tokens.
- Linking is best effort. A failure keeps the tokens.

## Profile Photos

- `identities/avatar.ts` owns the rules. Save and fetch only HTTPS URLs on
  the provider photo hosts.
- Browsers never contact Slack or Google and never see the provider URL.
  APIs return the Junior path `GET /api/people/avatars/:identityId`.

## Allowed Domains

- `chat/sign-in/allowlist.ts` owns one list for Slack and the dashboard. An
  empty list allows every domain.
- Slack ingress starts a Turn only for an author on an allowed domain. The
  dashboard accepts Google sign-in only for an allowed verified `hd` claim.
