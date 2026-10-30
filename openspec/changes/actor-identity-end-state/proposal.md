# Actor Identity End State

## Summary

Every Conversation has one Owner. Every new user Message has one author
Identity. Junior resolves each Identity one time at ingress and stores its
id. Later code reads the stored id. It does not guess the Identity again from
platform strings, the Source, or id patterns.

This plan records the end state for #2439. It also gives the order of the
steps that get there.

## Motivation

The runtime `Actor` is typed (`chat/actor.ts`). Stored state changes it to
`StoredSlackActor`. Many write and read paths then guess the Identity again.
Each guess can drift. Two examples:

- `SqlStore.upsertConversation` derives the Identity from the incoming Conversation
  and writes `coalesce(excluded.actor_identity_id, existing)`. A Conversation
  that starts with no Identity gets the Identity of the first writer that has
  one. Thus the first human who replies can become the root of an automation
  Conversation (#2431).
- `actorFromIdentityRow` (`chat/conversations/sql/actor-identity.ts`) returns
  no Actor for a system Identity. The next write then derives a system Identity
  from the Source again (`systemIdentityFromSource`).

`junior_conversations.actor_identity_id` also does four jobs: the root that the
dashboard shows, private access, spend, and the personal feed.

## Decisions

### Owner

- The Owner is the Identity that started the Conversation.
- For a Slack, web, or fork Conversation, the Owner is the human who started it.
  `forkConversation` already makes the requester the owner of the new root
  (`chat/conversations/README.md`, Conversation Forks).
- For a scheduled automation, an event automation, a plugin dispatch, or the
  local CLI, the Owner is the one system Identity.
- Junior sets the Owner one time, when it creates the Conversation. The Owner
  never transfers. A reply never changes it. This removes the "first human
  replier becomes root" behavior.
- The Owner is a Conversation term. An Automation also "has an owner"
  (`TERMINOLOGY.md`). That owner is the Automation creator, which stays on the
  Automation (`junior_automations.creator_identity_id`). The Automation creator
  is not the Owner of the Conversations that its runs create.

### Child Conversations

- A child Conversation stores no Owner. It reads the Owner of its root
  Conversation through `root_conversation_id`.
- This is the current access rule. `api/conversations/access.ts` already joins
  the root Conversation and reads the root Identity. It does not read the
  child's own column.
- #2382 uses the same rule for visibility: child Conversations do not store a
  value and read their root.
- `onBehalfOf` from #2181 does not change the Owner. It is Message provenance.
  It tells Guardian whose work a child instruction serves. It does not give
  access, spend, or feed rights.

### System Identity

- Junior has exactly one system Identity.
- "Which system" is provenance, not Identity. Junior gets it from the
  Conversation Source (`scheduler`, `event`, `plugin`, `local`, `internal`)
  and from the Automation or dispatch record (#2211).
- Today `systemIdentityFromSource` creates three system Identity rows, with
  provider `junior` and subjects `scheduler`, `local-cli`, and `event`. A
  migration moves every reference from these rows to the one system Identity.
  Then it deletes the three rows.
- `SystemActor.name` values stay in code as runtime provenance. Examples are
  `scheduled-automation`, `event`, `conversation-title`, `workspace-snapshot`,
  and plugin names. Runtime code reads these names. For example,
  `task-execution/mailbox-turn.ts` compares `actor.name` with
  `EVENT_SYSTEM_ACTOR.name`, and Guardian keeps `actor.name` in
  `guardian/gate.ts`. All of these Actors map to the one system Identity.
- A Slack bot is not the system Identity. See Slack Bots.
- A `LocalActor` (local CLI) also maps to the one system Identity. The local
  runner uses one shared user id for every person, so it cannot name a human.

### Web User

- A web Actor's Identity is the `google` Identity that dashboard sign-in saves.
- Sign-in flow, from the code:
  - The Better Auth `after` hook in `chat/sign-in/auth.ts` reads the Google
    account of each new session. It calls `recordGoogleSignIn`.
  - `recordGoogleSignIn` (`chat/identities/sql.ts`) calls `upsertIdentity`
    with kind `user`, provider `google`, and the Google OIDC `sub` as the
    subject. It sets `signed_in_at`. `upsertIdentity` links the Identity to the
    user of its verified email.
  - The dashboard `requireAuth` middleware
    (`packages/junior-dashboard/src/app.ts`) calls `resolveViewerUser(email)`.
    `resolveViewerUserFromSql` (`chat/plugins/viewer.ts`) finds or creates the
    `junior_users` row for that email. That row is the viewer.
- The synthetic web Identity goes away. Today it has provider `junior` and the
  email as the subject. `identityFromActor` and `resolveEventActorIdentityId`
  write it.
- `WebActor.userId` stays `dashboard:<hash>` (`webActorFromEmail`). It is a
  provider-scoped Actor id, not an Identity id.
- Every web Actor resolves to a real Identity. There is no fallback to the
  system Identity.
- The mock viewer creates a mock Identity. Today `mockViewerFromSession`
  (`packages/junior-dashboard/src/app.ts`) makes a viewer without durable user
  rows.
- Older sessions need no invalidation. The code shows this:
  - Better Auth has no database adapter (`chat/sign-in/auth.ts`). Sessions are
    JWE cookies with `disableSessionRefresh` and a default maximum age of 8
    hours (`DEFAULT_SESSION_MAX_AGE_SECONDS`).
  - Each new session runs the `after` hook, which calls `recordGoogleSignIn`.
    The hook throws when the Google account is missing. It skips only a
    session with no verified email, and the dashboard rejects that session
    (`verifiedDashboardSessionEmail`).
  - `recordGoogleSignIn` shipped in #2220 on 2026-10-26. Any session from
    before that date expired long ago.
  - So each live browser session has a `google` Identity row, linked to the
    viewer's `junior_users` row through the verified email.
- The session itself does not carry a Junior user id. The dashboard session
  keeps only `email`, `emailVerified`, and `name`
  (`sanitizeDashboardSession` in `packages/junior-dashboard/src/auth.ts`).
  The middleware finds the user by email. A User alone does not prove a
  `google` row. The 8-hour session limit gives that proof.
- Personal-token requests have no `google` row either. They are `GET` only
  (`requireAuth`), so they never write a Message.
- **Proposal:** the local auth bypass (`authRequired` is false,
  `dev@example.com`) creates a mock Identity, the same as the mock viewer.

### Identity Id Placement

- The Identity id goes next to the Actor on the Turn and on each Message. It
  does not go inside `Actor`.
- `actorSchema` in `packages/junior-plugin-api/src/schemas.ts` is a union of
  `.strict()` objects. A new field inside `Actor` would make older workers and
  external plugins reject the value.
- Turn: the Turn cursor stores `actor` (`task-execution/turn-cursor.ts`). It
  gets `actorIdentityId` next to it.
- Message: the event row already has `actor_identity_id`. Message event data
  already has the optional `authorIdentityId` (`chat/conversations/history.ts`).
- Conversation: `ownerIdentityId` replaces the stored Actor.

### No Unknown Actors

- Every new user Message row has an author Identity in
  `junior_conversation_events.actor_identity_id`. A user Message is an inbound
  Message, with role `user`.
- A user Message from a human uses the human's Identity.
- A user Message from a system Actor uses the system Identity. Examples are
  event, scheduled automation, and plugin dispatch prompts, and local CLI
  input.
- A user Message from a Slack bot uses the bot's own Identity. See Slack Bots.
- Assistant output is an event. It has no author Identity.
- No code writes `system`-role Message rows today.
  `ConversationMessageRole` (`chat/conversations/messages.ts`) allows the
  value, but each writer sets `user` or `assistant`.
- Junior resolves the author at ingress. Code that cannot name an author fails.
  It does not store an unknown author.
- Missing-author fallbacks exist only to read legacy rows. They log when they
  run.

## Schema

### `junior_conversations`

| Column                           | End state                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `owner_identity_id`              | New. Set one time at insert. Never updated. Required for new root rows. `null` on child rows. Replaces `actor_identity_id`.          |
| `actor_identity_id`              | Dropped after every reader moves.                                                                                                    |
| `creator_identity_id`            | Dropped. It would always equal the Owner. `SqlStore.upsertConversation` writes `null` and no code reads it.                          |
| `credential_subject_identity_id` | Dropped. `SqlStore.upsertConversation` writes `null` and no code reads it.                                                           |
| `actor_json`                     | Dropped. Writes are always `null`. Only the legacy guard in `conversationFromRow` and one purge predicate in `sql/purge.ts` read it. |

"Required for new root rows" is a `NOT VALID` check constraint:
`parent_conversation_id is not null or owner_identity_id is not null`. Legacy
rows can stay `null`. New rows cannot.

`junior_agent_invocations.actor_json` is a different column. It does not
change.

### `junior_conversation_events`

- `actor_identity_id` stays. It is the author Identity.
- A `NOT VALID` check constraint requires it for new user Message rows.
- Role is not a column. `type` is a column, and role is the top-level
  `payload->>'role'` field. `message` and `message_updated` payloads are not
  encoded (`isEncodedHistoryType` in `chat/conversations/history-payload.ts`),
  and `api/conversations/first-message.ts` already filters on
  `payload->>'role' = 'user'`. The constraint is:

  ```sql
  alter table junior_conversation_events
    add constraint junior_conversation_events_user_message_author_check
    check (
      type not in ('message', 'message_updated')
      or payload->>'role' is distinct from 'user'
      or actor_identity_id is not null
    ) not valid;
  ```

- The constraint does not cover the `user_message` agent history items. They
  are model input, not Messages, and their payload is encoded.

### Slack Bots

- A Slack bot gets its own Identity: provider `slack`, the Slack team id as
  tenant, and the bot id as subject. It has no linked User. It is the author
  of the bot's Messages.
- `junior_identities.user_id` is nullable (`db/schema/identities.ts`).
  `upsertIdentityRecord` writes `userId ?? null`.
- **Proposal:** add a `bot` kind. `IdentityKind` is `service`, `system`, or
  `user` (`chat/identities/identity.ts`). Do not use `user`: `upsertIdentity`
  creates and links a User for a `user` Identity with a verified email, and
  `userLookup` (`chat/tools/user-lookup.ts`) and `chat/events/people.ts`
  match on `kind = 'user'`. Do not use `service`: no code writes it today, and
  Service account in `TERMINOLOGY.md` means Junior's own provider account.
- With no User and a non-`user` kind, a bot never counts as a person:
  - Spend and People join `junior_users` and require `kind = 'user'`
    (`verifiedActorWhere` in `api/people/shared.ts`).
  - `recordConversationParticipant` skips an Identity without a User or with
    a kind other than `user`. So a bot never gets access as a participant.
- Today `resolveEventActorIdentityId` stores no author when
  `meta.author.isBot` is true. Guardian's `messageAuthor`
  (`agent-invocations/root-conversation.ts`) labels a bot as a `SystemActor`
  with the bot id as its name. Step 5 moves both to the bot Identity.

### Participants

- Junior derives participants from Message authors. `recordConversationParticipant`
  (`chat/conversations/sql/participants.ts`) already adds a linked user for
  each human author (`sql/history.ts`). It skips system Identities.
- A human Owner is a participant. The root seed in
  `SqlStore.upsertConversation` stays, and reads `owner_identity_id`.
- A system Owner adds no participant.

### Automations

- `junior_automations.creator_identity_id` stays. It is the Automation
  creator. It controls the Automation and its delegated credentials.

## Readers To Move

Each reader of the Conversation column moves to `owner_identity_id`. Readers
of the event column keep `actor_identity_id`.

| File                                              | Column it reads now                                                   | End state                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `api/conversations/access.ts`                     | root Conversation `actor_identity_id`                                 | root `owner_identity_id`                                                  |
| `api/conversations/list.ts`                       | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/conversations/membership.ts`                 | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/conversations/participants.ts`               | Conversation and event `actor_identity_id`                            | `owner_identity_id` and event `actor_identity_id`                         |
| `api/conversations/stats.query.ts`                | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/conversations/user-message-activity.ts`      | event `actor_identity_id`                                             | no change                                                                 |
| `api/people/list.query.ts`                        | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/people/profile.query.ts`                     | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/people/shared.ts`                            | root and child `actor_identity_id` (`peopleTreeMetricsJoin`)          | root `owner_identity_id` only                                             |
| `api/people/spend.query.ts`                       | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/locations/query.ts`                          | Conversation `actor_identity_id`                                      | `owner_identity_id`                                                       |
| `api/code/overview.ts`                            | linked Conversation `actor_identity_id` (raw SQL in `ownedByUserSql`) | root `owner_identity_id`, through `root_conversation_id`                  |
| `chat/conversations/sql/store.ts`                 | write, `returning`, list join, and `conversationFromRow`              | write `owner_identity_id` at insert only, and read it into `Conversation` |
| `chat/conversations/sql/participants.ts`          | an Identity id argument                                               | no change; the root seed passes `owner_identity_id`                       |
| `chat/conversations/sql/history.ts`               | event `actor_identity_id`                                             | no change; required for new Message rows                                  |
| `chat/conversations/fork.ts`                      | event `actor_identity_id` (copied events)                             | no change; the fork Owner comes from the requester web Actor              |
| `chat/conversations/sql/purge.ts`                 | `actor_json`                                                          | remove the `actor_json` predicate                                         |
| `db/schema/conversations.ts`, migrations, indexes | all four columns                                                      | add `owner_identity_id` and its index; drop the old columns               |

## Behavior Changes

- Automation-run spend no longer shows in personal spend. A system Owner has no
  user, so `api/people/spend.query.ts` does not count it for a person.
- A human who replies to an automation Conversation gets access as a
  participant, not as Owner. The Conversation stays in their feed through the
  participant row. It does not count as theirs in People or spend.
- Child spend rolls up to the root Owner. Today `peopleTreeMetricsJoin`
  (`api/people/shared.ts`) gives a child's metrics to the child's own Actor
  when that Actor differs from the root Actor.
- A web user's Messages and Conversations use their `google` Identity. The
  People page groups them with the same user as before, because both
  Identities link to the same `junior_users` row.

## Non-Goals

- Key user credentials by Junior user. This was step 6 of #2439. It is a
  separate change.
- Change `SystemActor` names or the `Actor` schema.
- Change Guardian authority. #2181 and #2260 own that.
- Change visibility. #2382 owns that.

## Open Questions

1. **Legacy `junior/<email>` rows with no `google` row.** A user who used the
   dashboard but never signed in after `recordGoogleSignIn` shipped has only the
   synthetic row. Proposed answer: the backfill keeps these rows for legacy
   reads and counts them in the dry run. New writes never use them.
2. **Bots and the system Identity in the participant list.**
   `readConversationParticipants` (`api/conversations/participants.ts`) lists
   every Message author Identity, with no `kind` filter. Once bots and system
   prompts have authors, they show there. **Proposal:** list only Identities
   with a linked User.

## Decided

These are David Cramer's answers in the #2439 thread.

- **Assistant output** is an event and has no author Identity.
- **Web users** always have an Identity. The mock viewer mocks one. David
  asked if older sessions get invalidated. The code shows that they need no
  invalidation (see Web User).
- **Child spend** rolls up to the root Owner.
- **Slack bots** have an Identity but no User. A bot is still an Actor.

## Docs To Update Later

- `TERMINOLOGY.md`: add **Owner**: the Identity that started a Conversation.
  Junior sets it one time at create. It never transfers. Say that it differs
  from the Automation owner.
- `packages/junior/src/chat/README.md`, Ownership section: add the Owner rule
  for Conversations, next to `conversations/`. The Attribution paragraph in
  Target Interface already says that an Automation creator does not become a
  "general task owner". Keep that text and link it to Owner.
- `packages/junior/src/chat/conversations/README.md`: replace "root actor" with
  Owner, and add the child rule.
- `packages/junior/src/chat/identities/README.md`: document the one system
  Identity and remove the synthetic web Identity.

## Risks

- The Owner backfill changes access, the feed, People, and spend. Do a dry-run
  count first, and keep participant rows for every human who loses the Owner.
- Old workers can still write `actor_identity_id` during a deploy. Write both
  columns until every reader moves. Then drop the old column in a later
  release.
- A Conversation write that has no Identity id now fails. A missed ingress
  path shows up as an error, not as wrong data. Log the legacy fallback before
  the constraint ships, so the logs find missed paths first.
