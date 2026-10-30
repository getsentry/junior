# Design

`proposal.md` says which items are decided and which are proposals. This file
gives the model, the schema, the readers, and the known gaps.

## Model

### Owner

- The Owner is the Identity that started a root Conversation.
- Slack, web, and fork Conversations: the human who started it.
  `forkConversation` already makes the requester the Owner of the new root
  (`chat/conversations/README.md`, Conversation Forks).
- Scheduled automations, event automations, plugin dispatch, and the local
  CLI: the system Identity.
- Junior sets the Owner at insert. The conflict update never changes it.
- The owner of an Automation (`TERMINOLOGY.md`) is a different thing. It is
  the Automation creator, in `junior_automations.creator_identity_id`. It is
  not the Owner of the Conversations that its runs create.

### Child Conversations

- A child stores no Owner. It reads its root Owner through
  `root_conversation_id`.
- `api/conversations/access.ts` already reads the root Identity, not the
  child's own column. #2382 uses the same rule for visibility.
- Child spend goes to the root Owner.
- `onBehalfOf` (#2181) is Message provenance. It gives no access, spend, or
  feed rights.

### System Identity

- Junior has one system Identity. Every `SystemActor` and every `LocalActor`
  maps to it.
- "Which system" is provenance. It comes from the Conversation Source and
  the Automation or dispatch record (#2211).
- `SystemActor.name` stays in code. Runtime code reads it, for example
  `task-execution/mailbox-turn.ts` and `guardian/gate.ts`.
- Today `systemIdentityFromSource` (`sql/actor-identity.ts`) writes three
  system rows: provider `junior`, subjects `scheduler`, `local-cli`, and
  `event`. Step 3 merges them into one.

### Web Users

- A web Actor uses the `google` Identity that dashboard sign-in saves:
  - The Better Auth `after` hook (`chat/sign-in/auth.ts`) calls
    `recordGoogleSignIn` for each new session.
  - `recordGoogleSignIn` (`chat/identities/sql.ts`) upserts kind `user`,
    provider `google`, and the OIDC `sub`. It links the User of the verified
    email.
  - The dashboard `requireAuth` middleware finds the viewer User by email
    (`resolveViewerUserFromSql` in `chat/plugins/viewer.ts`).
- Old sessions need no invalidation. Sessions are JWE cookies with no database
  and a maximum age of 8 hours. `recordGoogleSignIn` shipped in #2220 on
  2026-10-26. So each live session has a `google` row.
- `WebActor.userId` stays `dashboard:<hash>`. It is an Actor id, not an
  Identity id.
- The mock viewer (`mockViewerFromSession` in `junior-dashboard/src/app.ts`)
  gets a mock Identity. Today it has `identities: []`.
- Personal-token requests are `GET` only. They never write a Message.

### Slack Bots

- A Slack bot gets an Identity: provider `slack`, the team id as tenant, and
  the bot id as subject. It has no User. `junior_identities.user_id` is
  nullable.
- With no User, a bot never counts as a person. Spend and People require a
  User and kind `user` (`verifiedActorWhere` in `api/people/shared.ts`).
  `recordConversationParticipant` skips an Identity with no User.

### Event Authors

- Today no event Message has an author Identity:
  - `createEventInboundMessage` (`chat/events/notification.ts`) writes one
    stand-in author id. Event Turns use `EVENT_MESSAGE_AUTHOR`, a bot
    (`chat/events/actor.ts`). `resolveEventActorIdentityId` skips bots.
  - `gitHubDoneBy` (`junior-github/src/webhooks/events.ts`) sends only the
    login, for comments and reviews. The plugin keeps `senderId` in trusted
    `data`. Core does not read it.
  - Core uses `doneBy` only to find a Slack mention
    (`chat/events/people.ts`).
- End state: an event with an actor uses the Identity of that person or bot.
  Other events use the system Identity. Provider parsing stays in the plugin.
  `proposal.md` items 3 to 6 give the contract.
- Event text stays untrusted. Plugins put it in `untrustedText`.
  `task-input.ts` shows it as "External text". Guardian denies actions that
  follow it (`untrusted_instruction` in `guardian/policy.ts`).
- Event automations write no event Message. They start an Automation run
  (`chat/event-automations/ingest.ts`).

### Message Authors

- A user Message is a Message with role `user`. Every new user Message row
  has an author Identity:
  - a human uses their Identity;
  - a Slack bot uses its bot Identity;
  - an event uses its author Identity or the system Identity;
  - a scheduled automation, a plugin dispatch, or the local CLI uses the
    system Identity.
- Assistant output is an event. It has no author Identity.
- No code writes `system`-role Message rows. `ConversationMessageRole`
  allows the value, but each writer sets `user` or `assistant`.
- Junior resolves the author at ingress. A missing author fails the write.
  Fallbacks exist only to read legacy rows, and they log.

### Identity Id Placement

- The Identity id goes next to the Actor, not inside `Actor`. `actorSchema`
  (`junior-plugin-api/src/schemas.ts`) is a union of `.strict()` objects. A new
  field would make old workers and external plugins reject it.
- Turn: `actorIdentityId` next to `actor` in the Turn cursor
  (`task-execution/turn-cursor.ts`). Its schema uses `.strip()`, so an old
  worker drops the field.
- Mailbox: `actorIdentityId` on the mailbox entry (`inboundMessageSchema` in
  `task-execution/state.ts`). This schema is `.strict()`. Readers must accept
  the field one release before a writer sets it.
- Message: `junior_conversation_events.actor_identity_id`, and the optional
  `authorIdentityId` in Message event data (`chat/conversations/history.ts`).
- Conversation: `ownerIdentityId` replaces the stored Actor.

## Schema

### `junior_conversations`

| Column                           | End state                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `owner_identity_id`              | New. Set at insert, never updated. `null` on child rows. Indexed.               |
| `actor_identity_id`              | Dropped after every reader moves.                                               |
| `creator_identity_id`            | Dropped. Always written `null`. No reader.                                      |
| `credential_subject_identity_id` | Dropped. Always written `null`. No reader.                                      |
| `actor_json`                     | Dropped. Always written `null`. Read only by `conversationFromRow` and `purge`. |

A `NOT VALID` check requires the Owner on new root rows:
`parent_conversation_id is not null or owner_identity_id is not null`.

`junior_agent_invocations.actor_json` is a different column. It does not
change.

### `junior_conversation_events`

`actor_identity_id` stays. It is the author Identity. Role is the top-level
`payload->>'role'` field, not a column. `message` and `message_updated`
payloads are not encoded (`isEncodedHistoryType` in
`chat/conversations/history-payload.ts`).

```sql
alter table junior_conversation_events
  add constraint junior_conversation_events_user_message_author_check
  check (
    type not in ('message', 'message_updated')
    or payload->>'role' is distinct from 'user'
    or actor_identity_id is not null
  ) not valid;
```

The check does not cover `user_message` agent history items. They are model
input, not Messages, and their payload is encoded.

### `junior_automations`

`creator_identity_id` stays. It is the Automation creator.

## Readers

All paths are under `packages/junior/src/`. Each reader of the Conversation
column moves to the Owner. Each reader of the event column keeps the author.

| File                                         | Reads now                                        | End state                                          |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `api/conversations/access.ts`                | root Conversation column                         | root Owner                                         |
| `api/conversations/list.ts`                  | Conversation column                              | Owner                                              |
| `api/conversations/membership.ts`            | Conversation column                              | Owner                                              |
| `api/conversations/participants.ts`          | Conversation and event columns                   | Owner and author                                   |
| `api/conversations/stats.query.ts`           | Conversation column                              | Owner                                              |
| `api/conversations/user-message-activity.ts` | event column                                     | author, no change                                  |
| `api/people/list.query.ts`                   | Conversation column                              | Owner                                              |
| `api/people/profile.query.ts`                | Conversation column                              | Owner                                              |
| `api/people/shared.ts`                       | root and child columns (`peopleTreeMetricsJoin`) | root Owner only                                    |
| `api/people/spend.query.ts`                  | Conversation column                              | Owner                                              |
| `api/locations/query.ts`                     | Conversation column                              | Owner                                              |
| `api/code/overview.ts`                       | linked Conversation column (raw SQL)             | root Owner, through `root_conversation_id`         |
| `chat/conversations/sql/store.ts`            | write, `returning`, list join, read              | write the Owner at insert, read it                 |
| `chat/conversations/sql/participants.ts`     | an Identity id argument                          | no change; the root seed passes the Owner          |
| `chat/conversations/sql/history.ts`          | event column                                     | author, required for new user Messages             |
| `chat/conversations/fork.ts`                 | event column on copied events                    | author, no change; the fork Owner is the requester |
| `chat/conversations/sql/purge.ts`            | `actor_json`                                     | remove the `actor_json` predicate                  |
| `db/schema/conversations.ts`                 | all four columns                                 | add `owner_identity_id`; drop the other four       |
| `db/schema/conversation-events.ts`           | event column and index                           | no change                                          |

## Known Gaps

Checked against `main` at `28aeab3`. "Confirmed" means the cited code shows
the fault. "Traced" means the fault follows from a path through several files.
No gap was reproduced at runtime. No production data was queried.

No gap is fully fixed on `main`. #2436 fixed part of gap 10. #2437 fixed part
of gap 17. #2440 fixed part of gap 19. #2443 is open.

| #   | Gap                                                                                                                                                                                                    | Where                                                                 | Step                              | Evidence  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------- | --------- |
| 1   | No event Message has an author Identity. Core does not read the GitHub sender id.                                                                                                                      | `chat/events/notification.ts`, `junior-github/src/webhooks/events.ts` | 3                                 | Confirmed |
| 2   | Guardian sends every web Actor as `platform: "local"`. `ToolActionProposal` has no web variant.                                                                                                        | `guardian/gate.ts`, `guardian/proposal.ts`                            | 5                                 | Confirmed |
| 3   | `messageAuthor` takes the author platform from the root Source or Location. A bot author gets no Actor. The Automation input Message is found by an id prefix.                                         | `agent-invocations/root-conversation.ts`                              | 5                                 | Confirmed |
| 4   | `sessionLogActor` drops every Actor that is not Slack, so web, local, and system Turns record no Actor.                                                                                                | `task-execution/turn-cursor.ts`                                       | 2, 5                              | Confirmed |
| 5   | `recordConversationActivityMetadata` guesses the Source. A web Turn with no saved Source gets `local`.                                                                                                 | `task-execution/turn-cursor.ts`                                       | 5                                 | Traced    |
| 6   | `resolveEventActorIdentityId` picks Slack by an id regex, takes the workspace from the Location, and writes the synthetic web Identity. #2443 moves the mapping but keeps the guesses.                 | `chat/conversations/sql/event-actor.ts`                               | 1, 3, 5                           | Confirmed |
| 7   | The participant list has no `kind` filter, so system Identities show.                                                                                                                                  | `api/conversations/participants.ts`                                   | 3 (Open Question 2)               | Confirmed |
| 8   | Locations group actors by Identity, so a person with two Identities shows two times.                                                                                                                   | `api/locations/query.ts`                                              | 4 (Proposal 8)                    | Confirmed |
| 9   | Connections are keyed per platform. A Slack connection does not show on the web.                                                                                                                       | `api/connections/routes.ts`                                           | Non-Goal                          | Confirmed |
| 10  | A system root reads back with no Actor. The next human Turn then writes its own Identity with `coalesce(excluded, existing)`. #2436 fixed only the Source case. Writes are locked, so this is no race. | `chat/conversations/sql/store.ts`, `sql/actor-identity.ts`            | 2, 4                              | Traced    |
| 11  | System Identity subjects (`scheduler`, `local-cli`, `event`) do not match `SystemActor.name` values.                                                                                                   | `sql/actor-identity.ts`                                               | 3                                 | Confirmed |
| 12  | The local CLI uses one user id, `local-cli`, for every person and for its tokens.                                                                                                                      | `chat/local/runner.ts`, `chat/local/credential-sync.ts`               | 3; naming the human: Non-Goal     | Confirmed |
| 13  | `actorSchema` is closed. A TODO says system Actors should not use `platform: "system"`.                                                                                                                | `junior-plugin-api/src/schemas.ts`                                    | Non-Goal                          | Confirmed |
| 14  | The dashboard author shape is Slack only. It cannot show a system, bot, or GitHub author.                                                                                                              | `api/schema/conversation.ts`                                          | 5 (Proposal 9)                    | Confirmed |
| 15  | `Conversation.actor` and Redis work state are `StoredSlackActor`.                                                                                                                                      | `chat/conversations/store.ts`, `task-execution/state.ts`              | 5                                 | Confirmed |
| 16  | `creator_identity_id` and `credential_subject_identity_id` are always `null`.                                                                                                                          | `chat/conversations/sql/store.ts`                                     | 2, 4                              | Confirmed |
| 17  | Web uses the synthetic `junior/<email>` Identity. The mock viewer and the local bypass have none. #2437 fixed only the read side.                                                                      | `sql/actor-identity.ts`, `junior-dashboard/src/app.ts`                | 3                                 | Confirmed |
| 18  | No rule checks if an author Identity has a User before Junior follows its text. Authority comes from the Turn Actor and the text channel.                                                              | `agent-invocations/root-conversation.ts`, `guardian/policy.ts`        | 5 (Open Question 4)               | Traced    |
| 19  | Bad rows: web roots with a system Identity from before #2436, and wrong Location visibility from before #2440. No fix repaired them.                                                                   | `junior_conversations`, `junior_destinations`                         | 4 (Proposal 7); visibility: #2382 | Traced    |
