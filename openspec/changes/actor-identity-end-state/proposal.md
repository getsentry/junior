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
  plugin names, and Slack bot ids. Runtime code reads these names. For example,
  `task-execution/mailbox-turn.ts` compares `actor.name` with
  `EVENT_SYSTEM_ACTOR.name`, and Guardian keeps `actor.name` in
  `guardian/gate.ts`. All of these Actors map to the one system Identity.
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
- Assistant output is an event. It has no author Identity. This rule does not
  cover Messages with role `assistant` or `system`.
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
- Child spend: see open question 4. It is not decided.
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

1. **Web Actor without a `google` Identity.** The local auth bypass
   (`authRequired` is false) uses `dev@example.com` and never signs in with
   Google. The mock viewer also has no Google Identity. Also, a session that
   started before `recordGoogleSignIn` shipped can have no `google` row until
   the next sign-in. Proposed answer: in production, fail closed and ask the
   user to sign in again. In the local bypass, map the web Actor to the system
   Identity, as for the local CLI. Confirm.
2. **Slack bot authors.** A Slack bot Message comes in with role `user`, so
   the author rule covers it. It still needs an answer.
   `agent-invocations/root-conversation.ts` already treats a Slack bot author
   as a `SystemActor` with the bot id as its name. Today
   `resolveEventActorIdentityId` stores no Identity when `meta.author.isBot` is
   true. Proposed answer: bot Messages use the system Identity and keep the bot
   id as provenance. Confirm.
3. **Legacy `junior/<email>` rows with no `google` row.** A user who used the
   dashboard but never signed in after `recordGoogleSignIn` shipped has only the
   synthetic row. Proposed answer: the backfill keeps these rows for legacy
   reads and counts them in the dry run. New writes never use them.
4. **Child spend roll-up.** Today `peopleTreeMetricsJoin`
   (`api/people/shared.ts`) gives a child's metrics to the child's own Actor
   when that Actor differs from the root Actor. A child has no Owner in the end
   state. Proposed answer: the root Owner gets the child's spend. Confirm.

## Decided

- **Assistant and system Messages** (David Cramer): assistant output is an
  event, not an authored Message. The author rule and its check constraint
  cover only user Messages. Assistant and system Messages keep a `null`
  author.

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
