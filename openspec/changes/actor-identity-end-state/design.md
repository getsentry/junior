# Design

`proposal.md` says who decided each item and what is still open. This file
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
- An Automation has a creator (`TERMINOLOGY.md`), in
  `junior_automations.creator_identity_id`. The creator is not the Owner of
  the Conversations that its runs create.

### Owner Repair

Before #2436, `recordExecution` could replace the human root Identity of a
`slack` or `web` root with a system Identity (`local-cli` or `event`). The
same `coalesce(excluded.actor_identity_id, existing)` write could also replace
one human Identity with a later human Identity. So today's Identity of a root
with more than one human author is not proof of its starter. David's
rule is: leave old rows as they are, unless the migration path is clearly
correct. Step 4b repairs a root only when all of these are true:

- the row is a root (`parent_conversation_id is null`);
- the row is not a fork (`forked_from_conversation_id is null`). A fork
  copies the events of its source, with their authors (`chat/conversations/fork.ts`),
  so its first author can be someone else;
- its Source is `slack` or `web`;
- its current Identity is of kind `system`;
- its first `message` event with role `user`, by `seq`, has an author
  Identity. Junior does not look past a first Message with no author;
- that author is kind `user`, links a User, and fits the Source: provider
  `slack` for a `slack` root, `google` or `junior` for a `web` root;
- it has one author User: every `message` event with role `user` has an
  author Identity, and each one links the same User as the first author. A
  root with more than one human author keeps its current Identity.

The repair then sets the Owner to that author Identity.

The dry run counts, by Source:

- the rows that pass every condition;
- the rows skipped, by the first condition that fails;
- the agreement check: for `slack` and `web` roots that are not forks, have
  a `user` Identity today, and have one author User (as above), the rows
  where that author is a different User from today's Identity;
- the roots with a `user` Identity today and more than one author User. The
  agreement check does not use them.

The agreement check tests the rule on rows that the old write did not damage.
On a root with one author User, a later human Turn cannot replace the
starter with a different human, unless a Turn actor is not a Message author.
So a disagreement there shows that the author does not identify the starter.
If the check finds one disagreement, the rule is not clearly correct. Then
step 4b drops the repair and copies the current Identity for every row. Each
skipped row also keeps its current Identity.

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
  `event`.
- #2443 (step 1) adds `chat/identities/actor.ts`. It exports two functions.
  The key for each Actor, and the web lookup, stay private in that module.
  - `resolveActorIdentityId(executor, actor, nowMs?)` writes the Identity and
    returns its id.
  - `findActorIdentityId(db, actor)` only reads. The viewer uses it, so a
    read never creates a row.
- #2443 maps every `SystemActor` and every `LocalActor` to the one system
  key, `system/junior/""/system`. No current caller passes one yet. So the
  row is first created in step 2, when the local CLI sets its author.
- A Conversation with no Actor still writes a legacy per-name row
  (`scheduler`, `local-cli`, or `event`). A private fallback in
  `sql/actor-identity.ts` (`systemIdentityFromSource`) writes it. Their
  display names, "Scheduler", "Local CLI", and "Event", are the root labels
  in the dashboard today. `api/conversations/list.ts` and `stats.query.ts`
  read them from `juniorIdentities.displayName`.
- With #2443, OAuth and message events write `metadata.platform` on an
  Identity that has no metadata yet. The upsert keeps existing metadata
  (`coalesce` in `upsertIdentityRecord`).
- Step 2 removes the fallback from the write path. Step 3 merges only legacy
  rows: every row of kind `system` that is not the one system Identity.
  Before it deletes them, the readers take the system label from the
  Conversation Source or the Automation or dispatch record (#2211). So no
  visible label changes to "System".

### Users And Identities

- A User is one person. A User has many Identities: for example a `slack`
  Identity, a `google` Identity from dashboard sign-in, and a `github`
  Identity from an OAuth link. Each one links the same `user_id`.
- `userSchema.identities` (`junior-plugin-api/src/schemas.ts`) already gives
  a viewer every linked Identity.
- Spend, People, participants, and Locations roll up by User. The Identity
  is the fallback only for an Identity with no User, such as a bot.
- A Message author and an Owner are Identities. A reader joins the Identity
  to its User to group.

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
- `WebActor` has no OIDC `sub` (`chat/actor.ts`). It has only the verified
  email. So a web Actor finds its `google` row through its User: the email
  gives the viewer User (`resolveViewerUserFromSql`). Junior then uses that
  User's `google` Identity with the newest `signed_in_at`.
- The mock viewer (`mockViewerFromSession` in `junior-dashboard/src/app.ts`)
  gets a mock Identity. Today it has `identities: []`. Mock reporting writes
  no durable rows, so this Identity is in memory only. Its id is
  `mock-identity:<email>`.
- The local auth bypass (`authRequired: false`) uses a real User for
  `dev@example.com` (`resolveViewerUser`). It has no Google sign-in. So the
  bypass branch of `requireAuth` writes a `mock` Identity with the same key
  as the mock viewer and links it to that User. A web Actor uses the viewer's
  `google` Identity. Only under the bypass does the viewer have a `mock`
  Identity in its place.
- Today only `apps/example/dashboard.ts` refuses the bypass on Vercel. The
  dashboard package accepts `authRequired: false` anywhere. Step 3 moves the
  guard into the package.
- Personal-token requests are `GET` only. They never write a Message.

### Slack Bots

- A Slack bot gets an Identity of kind `bot`: provider `slack`, the team id
  as tenant, and the bot user id (`U…`) as subject. It uses the `bot_id`
  (`B…`) only when Slack sends no bot user id. The bot has no User.
  `junior_identities.user_id` is nullable.
- With no User, a bot never counts as a person. Spend and People require a
  User and kind `user` (`verifiedActorWhere` in `api/people/shared.ts`).
  `recordConversationParticipant` skips an Identity with no User.

### Event Authors

An event is a Message. An inbound event writes a Message with role `user`.
Its author is the author Identity of the event: the system Identity for a
system event, or the person or bot who wrote the content. The event never
changes the Owner or the Turn Actor.

- Today no event Message has an author Identity:
  - `createEventInboundMessage` (`chat/events/notification.ts`) writes one
    stand-in author id. Event Turns use `EVENT_MESSAGE_AUTHOR`, a bot
    (`chat/events/actor.ts`). `resolveEventActorIdentityId` skips bots.
  - `gitHubDoneBy` (`junior-github/src/webhooks/events.ts`) sends only the
    login, for comments and reviews. The plugin keeps `senderId` in trusted
    `data`. Core does not read it.
  - Core uses `doneBy` only to find a Slack mention
    (`chat/events/people.ts`).
- End state: an event whose `doneBy` has a `subjectId` uses the Identity of
  that person or bot. An event with no `doneBy`, or with no `subjectId`, uses
  the system Identity. It is a system event: it runs as today, and its text
  stays data. So no `hasActor` flag is needed. Provider parsing stays in the
  plugin. `proposal.md`, Plan Decisions, gives the contract.
- Event text is untrusted by default. Plugins put it in `untrustedText`.
  `task-input.ts` shows it as "External text". Guardian denies actions that
  follow it (`untrusted_instruction` in `guardian/policy.ts`).
- End state for trust: Junior treats text from a trusted author exactly like
  a chat message from that author. An event from an untrusted or unknown
  author does not start a run (`proposal.md`, Plan Decisions). An author is
  trusted when the plugin says so, or when `findLinkedSlackMember()` returns
  `linked` for the author's account. #2260 adds it in
  `chat/identities/linked-slack-member.ts`. #2217 runs the same check inline
  in `agent-dispatch/context.ts`. It requires all of these:
  - the exact provider account id that the OAuth link stored, never a handle
    or an email;
  - exactly one linked Slack user in the workspace;
  - a current human member (`lookupActiveSlackWorkspaceMember`);
  - a Slack profile email on `allowedDomains` (`isSlackProfileDomainAllowed`).

  So a deactivated employee with a linked GitHub account is not trusted.

- Only `doneByText` can be trusted text. The plugin removes the lines
  that the author only quotes (`unquotedCommentText` in
  `junior-github/src/webhooks/events.ts`, #2260). Core renders the text in
  #2260's `Requester instruction` section. It is never a `user:` line. It
  authorizes what a chat message from that author would authorize.
- A batch of events is one Message (`task-execution/conversation-turn.ts`:
  `renderEventBatchText`, and `userMessageId` from the first entry). When
  every event in the batch has the same author Identity, that Identity is
  the Message author. Otherwise the Message author is the system Identity.
  Trust is decided per event, from each entry's `authorIdentityId`, before
  the Turn starts. Junior leaves the untrusted authored entries out of the
  batch. The batch Message author comes from the entries that are left. When
  no entry is left, no Turn starts.
- The author Identity provider is the event `namespace`. `doneBy.provider`
  must equal it, as #2260's `resolveEventDoerSlackUserId` requires. When the
  namespace is a core provider (`slack`, `google`, `junior`, `mock`), or the
  two values differ, the event uses the system Identity and its text stays
  data.
- The GitHub plugin owns its trusted authors list of logins,
  `githubPlugin({ trustedAuthors })`. It sets `doneBy.trustedAuthor`. Core
  sees only that boolean. This is the same split as
  `slack.allowedBotUserIds`, which lets a listed Slack bot pass the domain
  check (`chat/ingress/slack-allowed-domain.ts`). Today no GitHub author list
  exists.
- An event Message author never becomes a participant. Today `sql/history.ts`
  records a participant for each Message author with an Identity.
- Event automations write no event Message. They start an Automation run
  (`chat/event-automations/ingest.ts`).

### Identity Keys

The unique key of `junior_identities` is provider, tenant, and subject
(`junior_identities_provider_subject_uidx`). `kind` is a column, not part of
the key. Each row says who decided it.

| Identity     | Key                                                                                             | Status                         |
| ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| System       | kind `system`, provider `junior`, tenant `""`, subject `system`                                 | Delegated decision (answer 10) |
| Event author | provider the event `namespace`, tenant `""`, subject `doneBy.subjectId`; kind `bot` or `user`   | Plan decision                  |
| Slack bot    | kind `bot`, provider `slack`, tenant the team id, subject the bot user id (`U…`), else `bot_id` | Decided (answers 1 and 11)     |
| Web user     | the viewer User's `google` row with the newest `signed_in_at`                                   | Plan decision                  |
| Mock viewer  | kind `user`, provider `mock`, tenant `""`, subject the viewer email; in memory only             | Delegated decision (answer 12) |
| Auth bypass  | kind `user`, provider `mock`, tenant `""`, subject the viewer email; written only by the bypass | Delegated decision (answer 2)  |

- The event author key must match the row that the OAuth link writes.
  `linkOAuthAccountIdentity` (`handlers/oauth-callback.ts`) upserts the
  plugin provider, the default tenant `""`, and the account id. For GitHub
  that is provider `github`. The GitHub plugin
  sets that id with `String(id)` (`junior-github/src/credential-support.ts`).
  An event upsert never changes the `kind` or `user_id` of an existing row.
- An event upsert never changes the `kind` of an existing row. Today
  `upsertIdentityRecord` (`chat/identities/sql.ts`) sets
  `kind = excluded.kind` on conflict. Step 3 changes this for event
  upserts. `user_id` already uses `coalesce(existing, excluded)`.
- `slack.allowedBotUserIds` uses the bot user id (`U…`). So a Slack bot
  Identity uses it too when Slack sends it.
- No other row can take the system key or a `mock` key:
  - Plugin registration reserves the name `junior`
    (`junior-plugin-api/src/registration.ts`). Step 3 reserves `mock` there
    too.
  - Step 3 adds `junior` and `mock` to `isNativeIdentityProvider`
    (`chat/identities/identity.ts`), so an OAuth link never writes them.
  - The other `junior` rows use an email (it has `@`), or they are legacy
    system rows (`scheduler`, `local-cli`, `event`). Step 3 merges the
    legacy system rows into the system Identity.

### Guardian Labels

- Guardian labels come from the Actor and Message provenance. They never come
  from the Identity id alone.
- `messageLabel` (`agent-invocations/root-conversation.ts`) gives
  `automation` when the author is the Turn Actor. `sameActorIdentity`
  (`conversations/provenance.ts`) compares system Actors as
  `system ${name}`.
- With one system Identity, every system and CLI author has the same Identity
  id. So an Identity id compare would make every system author match the Turn
  Actor. Step 5 keeps the Actor compare. The stored Identity only replaces
  the platform guess for human and bot authors.

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
- Mailbox: `inboundMessageSchema` (`task-execution/state.ts`) has no `actor`
  field. The author is `input.authorId`, a platform author id. The new field
  is `input.authorIdentityId`, next to `input.authorId`. It has the same name
  as `authorIdentityId` in Message event data. `authorId` stays for display
  and Slack mentions. `agentInputSchema` is `.strict()`, so readers must
  accept the field one release before a writer sets it.
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
A `NOT VALID` check still applies to every new insert. `junior upgrade` runs
migrations while old workers still run (`cli/upgrade.md`). An old worker
inserts roots with no Owner (`upsertConversation` in `sql/store.ts`). So step
4a adds the column and the writer, and step 4b adds the check one release
later.

Each dropped column takes two releases. `conversationReadColumns()`
(`db/schema/conversations.ts`) selects every column in the Drizzle schema, so
an old worker selects a column by name. In release N, Junior stops all writes
and reads of the column. It leaves the column out of
`conversationReadColumns()`, the same as `legacyArchivedAt` today. The column
stays in the Drizzle schema, so `db:generate` makes no drop. In release N+1,
Junior removes the column from the schema and generates the drop.

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

| File                                         | Reads now                                        | End state                                           |
| -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `api/conversations/access.ts`                | root Conversation column                         | root Owner                                          |
| `api/conversations/list.ts`                  | Conversation column                              | Owner                                               |
| `api/conversations/membership.ts`            | Conversation column                              | Owner                                               |
| `api/conversations/participants.ts`          | Conversation and event columns, grouped by User  | Owner and author, grouped by User (no change)       |
| `api/conversations/stats.query.ts`           | Conversation column                              | Owner                                               |
| `api/conversations/user-message-activity.ts` | event column                                     | author, no change                                   |
| `api/people/list.query.ts`                   | Conversation column, grouped by User             | Owner, grouped by User (no change)                  |
| `api/people/profile.query.ts`                | Conversation column, grouped by User             | Owner, grouped by User (no change)                  |
| `api/people/shared.ts`                       | root and child columns (`peopleTreeMetricsJoin`) | root Owner only, grouped by its User                |
| `api/people/spend.query.ts`                  | Conversation column, grouped by User             | Owner, grouped by User (no change)                  |
| `api/locations/query.ts`                     | Conversation column, grouped by Identity         | Owner, grouped by User (Identity as fallback)       |
| `api/code/overview.ts`                       | linked Conversation column (raw SQL)             | root Owner, through `root_conversation_id`          |
| `chat/conversations/sql/store.ts`            | write, `returning`, list join, read              | write the Owner at insert, read it                  |
| `chat/conversations/sql/participants.ts`     | an Identity id argument                          | no change; the root seed passes the Owner           |
| `chat/conversations/sql/history.ts`          | event column                                     | author, required for new user Messages              |
| `chat/conversations/fork.ts`                 | event column on copied events                    | author, no change; the fork Owner is the requester  |
| `chat/conversations/sql/purge.ts`            | `actor_json`                                     | remove the `actor_json` predicate                   |
| `db/schema/conversations.ts`                 | all four columns                                 | add `owner_identity_id`; drop the other four        |
| `conversationReadColumns()`                  | every schema column (`list.ts`, `sql/store.ts`)  | leave each column out one release before its drop   |
| `junior_conversations_actor_activity_idx`    | index on `actor_identity_id`                     | replaced by an Owner index; dropped with the column |
| `db/schema/conversation-events.ts`           | event column and index                           | no change                                           |

## Known Gaps

Checked against `main` at `c122def15`. The only commit after `28aeab3`
(#2446) changes no file in this table. "Confirmed" means the cited code shows
the fault. "Traced" means the fault follows from a path through several files.
No gap was reproduced at runtime. No production data was queried.

No gap is fully fixed on `main`. #2436 fixed part of gap 10. #2437 fixed part
of gap 17. #2440 fixed part of gap 19. #2443 is open.

| #   | Gap                                                                                                                                                                                                    | Where                                                                 | Step                           | Evidence  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------ | --------- |
| 1   | No event Message has an author Identity. Core does not read the GitHub sender id.                                                                                                                      | `chat/events/notification.ts`, `junior-github/src/webhooks/events.ts` | 3                              | Confirmed |
| 2   | Guardian sends every web Actor as `platform: "local"`. `ToolActionProposal` has no web variant.                                                                                                        | `guardian/gate.ts`, `guardian/proposal.ts`                            | 5                              | Confirmed |
| 3   | `messageAuthor` takes the author platform from the root Source or Location. A bot author gets no Actor. The Automation input Message is found by an id prefix.                                         | `agent-invocations/root-conversation.ts`                              | 5                              | Confirmed |
| 4   | `sessionLogActor` drops every Actor that is not Slack, so web, local, and system Turns record no Actor.                                                                                                | `task-execution/turn-cursor.ts`                                       | 2, 5                           | Confirmed |
| 5   | `recordConversationActivityMetadata` guesses the Source. A web Turn with no saved Source gets `local`.                                                                                                 | `task-execution/turn-cursor.ts`                                       | 5                              | Traced    |
| 6   | `resolveEventActorIdentityId` picks Slack by an id regex, takes the workspace from the Location, and writes the synthetic web Identity. #2443 moves the mapping but keeps the guesses.                 | `chat/conversations/sql/event-actor.ts`                               | 1, 3, 5                        | Confirmed |
| 7   | The participant list has no `kind` filter, so system Identities show.                                                                                                                                  | `api/conversations/participants.ts`                                   | 3                              | Confirmed |
| 8   | Locations group actors by Identity, so a person with two Identities shows two times.                                                                                                                   | `api/locations/query.ts`                                              | 4b                             | Confirmed |
| 9   | Connections are keyed per platform. A Slack connection does not show on the web.                                                                                                                       | `api/connections/routes.ts`                                           | Non-Goal                       | Confirmed |
| 10  | A system root reads back with no Actor. The next human Turn then writes its own Identity with `coalesce(excluded, existing)`. #2436 fixed only the Source case. Writes are locked, so this is no race. | `chat/conversations/sql/store.ts`, `sql/actor-identity.ts`            | 2, 4a                          | Traced    |
| 11  | System Identity subjects (`scheduler`, `local-cli`, `event`) do not match `SystemActor.name` values.                                                                                                   | `sql/actor-identity.ts`                                               | 3                              | Confirmed |
| 12  | The local CLI uses one user id, `local-cli`, for every person and for its tokens.                                                                                                                      | `chat/local/runner.ts`, `chat/local/credential-sync.ts`               | 3; naming the human: Non-Goal  | Confirmed |
| 13  | `actorSchema` is closed. A TODO says system Actors should not use `platform: "system"`.                                                                                                                | `junior-plugin-api/src/schemas.ts`                                    | Non-Goal                       | Confirmed |
| 14  | The dashboard author shape is Slack only. It cannot show a system, bot, or GitHub author.                                                                                                              | `api/schema/conversation.ts`                                          | 5                              | Confirmed |
| 15  | `Conversation.actor` and Redis work state are `StoredSlackActor`.                                                                                                                                      | `chat/conversations/store.ts`, `task-execution/state.ts`              | 5                              | Confirmed |
| 16  | `creator_identity_id` and `credential_subject_identity_id` are always `null`.                                                                                                                          | `chat/conversations/sql/store.ts`                                     | 2, 6, 7                        | Confirmed |
| 17  | Web uses the synthetic `junior/<email>` Identity. The mock viewer and the local bypass have none. #2437 fixed only the read side.                                                                      | `sql/actor-identity.ts`, `junior-dashboard/src/app.ts`                | 3                              | Confirmed |
| 18  | No rule checks if an author Identity has a User before Junior follows its text. Authority comes from the Turn Actor and the text channel.                                                              | `agent-invocations/root-conversation.ts`, `guardian/policy.ts`        | 3                              | Traced    |
| 19  | Bad rows: web roots with a system Identity from before #2436, and wrong Location visibility from before #2440. No fix repaired them.                                                                   | `junior_conversations`, `junior_destinations`                         | 4b (repair); visibility: #2382 | Traced    |
