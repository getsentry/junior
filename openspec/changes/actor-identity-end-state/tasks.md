# Tasks

Each step ships on its own and leaves `main` correct. Test paths are under
`packages/junior/tests/`. Extend the owning scenario in each listed file. Do
not add tests for migration SQL.

## Release Rules

- A new field in a `.strict()` schema ships in a reader release before any
  writer sets it. This covers the mailbox entry (`agentInputSchema`),
  `eventDoerSchema` (`junior-plugin-api/src/events.ts`, #2260), and
  `requesterInstructionSchema` (`chat/events/requester.ts`, #2260, with
  `actor: slackActorSchema`).
- A `NOT VALID` check ships one release after every writer sets the value.
  `junior upgrade` runs migrations while old workers still run.
- A dropped column takes two releases (`design.md`, Schema). Release N stops
  all writes and reads and leaves it out of `conversationReadColumns()`.
  Release N+1 removes it from the Drizzle schema and generates the drop.

## Dependencies

- #2441 before step 2. Both change `SqlStore.recordExecution` and
  `task-execution/turn-cursor.ts`.
- #2260 (stacked on #2217) before step 3. Step 3 builds event authors on its
  `doneBy.subjectId`, and widens which event authors it trusts. Its Watch
  requester is provenance, not an Owner.
- #2382 before step 4a. Both add a `junior_conversations` column and change
  the write rule in `SqlStore.upsertConversation`.
- #2181 before step 5. Both change `agent-invocations/root-conversation.ts` and
  Guardian.
- #2211 owns the record of which Automation or dispatch did the work.

## 1. One Actor To Identity Mapping (#2443)

- [ ] `chat/identities/actor.ts` owns the mapping from Actor to Identity.
      It exports `resolveActorIdentityId(executor, actor)`. The web lookup
      stays inside the module.
- [ ] Every `SystemActor` and every `LocalActor` maps to the one system key
      (`design.md`, Identity Keys).
- [ ] Remove the copies in `sql/event-actor.ts`, `handlers/oauth-callback.ts`,
      and `plugins/viewer.ts`.

Backfill: none. No schema change.

Risk: low. It moves code. New system writes use the one system key, so step
3 merges only legacy rows.

Verify: the actor mapping unit test that #2443 adds, and
`integration/oauth-identity-link.test.ts`.

## 2. Carry The Identity Id

- [ ] Release A: readers accept the new optional fields:
      `input.authorIdentityId` in the mailbox entry (`agentInputSchema`,
      `.strict()`), and `actorIdentityId` next to `actor` in the Turn cursor
      (`.strip()`).
- [ ] Release B: each ingress calls `resolveActorIdentityId` one time and
      sets both fields. Ingress paths: Slack, web, fork, event, scheduled automation,
      event automation, plugin dispatch, local CLI, and Agent invocation.
- [ ] Each ingress sets `authorIdentityId` on each new user Message.
      Assistant output sets no author.
- [ ] Add `ownerIdentityId` to `Conversation`. Until step 4b it reads
      `actor_identity_id`. `conversationFromRow` returns it for every
      Identity kind, also system.
- [ ] `SqlStore.upsertConversation` writes the stored id. Remove
      `systemIdentityFromSource` and `mergeActor` from the write path.
- [ ] Release N for `creator_identity_id` and
      `credential_subject_identity_id`: stop writing them (the `null` insert
      values and the `coalesce` updates) and leave them out of
      `conversationReadColumns()`.
- [ ] Keep the legacy fallbacks for rows with no id. Log each time one runs.

Backfill: none. No schema change.

Risk: medium. An old worker rejects a mailbox entry with the new field.
Release A must deploy before release B.

Verify: `component/conversation-sql-store.test.ts`: a system root keeps its
Identity after a human Turn writes. `integration/conversation-turn-work.test.ts`:
a web Turn stores its author Identity.

## 3. One System Identity And Real Identities

- [ ] Change the web lookup inside `resolveActorIdentityId`: a web Actor
      uses the viewer User's newest `google` row (`design.md`, Identity
      Keys), not `junior/<email>`. Keep `SystemActor.name` as provenance.
- [ ] A web Actor never falls back to the system Identity.
- [ ] Add `junior` and `mock` to `isNativeIdentityProvider`, so an OAuth
      link never writes either provider.
- [ ] Reserve the plugin name `mock` in
      `junior-plugin-api/src/registration.ts`, next to `junior`.
- [ ] Give the mock viewer an in-memory `mock` Identity in
      `viewer.identities`. Write no row for it.
- [ ] The local auth bypass writes one `mock` Identity for its User, with the
      same key as the mock viewer. Move the Vercel guard of
      `apps/example/dashboard.ts` into the dashboard package, so
      `authRequired: false` fails to start on a Vercel production deploy.
- [ ] Add `bot` to `IdentityKind`. Map a Slack bot author to its own `bot`
      Identity with no User. The subject is the bot user id (`U…`), else the
      `bot_id`.
- [ ] Event Messages: the plugin sets `doneBy.subjectId`, `isBot`, and
      `trustedAuthor`. Core upserts the author Identity with the OAuth link key,
      kind `bot` when `isBot` is true, and no email. An event with no
      `doneBy` or no `subjectId` uses the system Identity.
- [ ] The author Identity provider is the event `namespace`. Require
      `doneBy.provider === namespace`. Refuse the core providers `slack`,
      `google`, `junior`, and `mock`, and use the system Identity.
- [ ] An event batch is one Message. Its author is the shared author
      Identity when every event has the same one, else the system Identity.
      Decide trust per event, from each entry's `authorIdentityId`.
- [ ] An event upsert never changes the `kind` or `user_id` of an existing
      row. Change the conflict update in `upsertIdentityRecord`
      (`chat/identities/sql.ts`), which sets `kind = excluded.kind` today.
- [ ] Event Message authors do not become participants. `sql/history.ts`
      skips `recordConversationParticipant` for event Messages.
- [ ] Event author trust (`proposal.md`, Plan Decisions). The GitHub plugin
      gets `githubPlugin({ trustedAuthors })`, a trusted authors list of
      GitHub logins. It compares logins without case. It sets
      `doneBy.trustedAuthor` when the event login is on the list. Core treats
      `doneByText` as trusted text only when `doneBy.trustedAuthor` is
      `true`, or when `findLinkedSlackMember()` returns `linked` for the
      author's account. Core reads no GitHub login for this.
- [ ] Render trusted text in #2260's `Requester instruction` section, never as
      a `user:` line. #2260's instruction record keeps the author Identity
      id, because a trusted bot has no Slack Actor.
- [ ] What trusted text may authorize waits for David (`proposal.md`, Open
      Questions). If he takes the recommended answer:
  - Rewrite `REQUESTER_INSTRUCTION_RULES` (`guardian/reviewer.ts`, #2260).
    It says that a trusted author's lines authorize the actions they ask
    for, the same as a chat message from that author. It drops the claim
    that the writer created the Watch. It says that the lines never answer a
    pending action-review approval prompt.
  - Let a Watch with no requester receive trusted author text. Today
    `events/ingest.ts` resolves the doer only when a subscription has a
    requester.
  - Make `requesterInstruction.mention` in `eventTaskFactsSchema`
    (`chat/events/notification.ts`) optional, and give a bot an Identity
    label instead.
  - Give a bot author its own Guardian label, from its `bot` Identity and
    the Message provenance.
- [ ] Document `trustedAuthors` in `junior-github/SETUP.md`. It can list
      bots and people. Warn that GitHub can give a renamed or deleted
      account's login to a new account. Say to list stable logins and to
      review the list.
- [ ] The participant list shows only Identities of kind `user` with a User,
      the same rule as participant rows.
- [ ] Stop writing new rows for each `SystemActor.name` and for
      `junior/<email>`.

Backfill: run it in the release after step 3, when no worker writes the old
keys. Workers from before step 1 keep writing the legacy system rows until
cutover.

1. Dry-run count: every legacy row of kind `system`, by subject, such as
   `scheduler`, `local-cli`, and `event`. For each row, count the references
   in every foreign key that points at `junior_identities`. Read the list
   from `pg_constraint`, not from this plan. Today it is
   `junior_conversations` (`actor_identity_id`, `creator_identity_id`,
   `credential_subject_identity_id`), `junior_conversation_events`
   (`actor_identity_id`), and `junior_automations` (`creator_identity_id`,
   `NOT NULL`).
2. Move every counted reference to the one system Identity. Then delete the
   old rows. Delete no row that still has a reference.
3. Move references from a `junior/<email>` row to a `google` row only when
   both rows link the same `user_id`. Leave every other `junior/<email>` row
   and reference as it is.

Risk: medium. Wrong merges move Conversations between People. The trust rule
changes which event text Junior follows. Only logins on the trusted authors
list and linked members on an allowed domain gain this.

Verify: `component/identity-read.test.ts`,
`integration/api/conversations/detail.test.ts` (participants),
`integration/local-agent-runner.test.ts`, and the review and comment scenario in
`packages/junior-github/tests/webhook-outcomes.test.ts`: a bot on the trusted
authors list is trusted, a bot that is not on the list is data only, a
deactivated linked member is data only, and the commenter gets no participant
row.

## 4a. Write The Owner

- [ ] Add the nullable `junior_conversations.owner_identity_id` and its
      index. Add no check yet.
- [ ] `SqlStore.upsertConversation` sets the Owner at insert. The conflict
      update never changes it. Child rows store `null`.
- [ ] Keep writing `actor_identity_id`. No reader moves yet.

Backfill: none.

Risk: low. Old workers insert roots with no Owner. Step 4b fills them.

Verify: `component/conversation-sql-store.test.ts`: a new root has its Owner,
and a reply does not change it.

## 4b. Backfill, Check, And Read The Owner

This is the riskiest step. It changes access, the feed, People, and spend.
Ship it after every worker runs step 4a.

- [ ] Run the backfill below.
- [ ] Add the `NOT VALID` check for new root rows (`design.md`, Schema).
- [ ] Move every reader in `design.md`, Readers, to the Owner.
- [ ] `api/locations/query.ts` groups actors by User, with the Identity as
      fallback.
- [ ] State the behavior changes in the PR (`proposal.md`).

Backfill:

1. Run a dry-run count and post it on #2439:
   - root rows by Source and Identity kind;
   - roots with a `slack` or `web` Source and a system Identity;
   - roots with a human Identity and a system Source (`scheduler`, `event`,
     `plugin`, `local`);
   - roots with no Identity;
   - child rows whose Identity differs from their root;
   - `junior/<email>` rows that are still referenced. Step 4b does not change
     them.
   - the Owner repair counts, the agreement check, and the roots with more
     than one author User (`design.md`, Owner Repair).
2. Roots with no Owner and a `slack` or `web` Source: copy
   `actor_identity_id`. When the agreement check found zero disagreements,
   repair each row that passes every Owner Repair condition. Otherwise drop
   the repair. Every skipped row keeps its current Identity. This includes
   each root with more than one author User.
3. Roots with no Owner and a system Source: the system Identity.
4. Roots with any other Source: hold until the dry run is reviewed.
5. Child rows: `null`.
6. Add a participant row for each human whose Identity was the root Identity
   and is not the Owner.

Risk: high. A wrong Owner hides or exposes a Conversation. The dry run and the
participant rows limit this.

Verify: `integration/agent-dispatch-work.test.ts`: a scheduled automation keeps
the system Owner after a human replies, and the human gets participant access.
`integration/api/conversations/child-agents.test.ts`: a child reads the root
Owner. `integration/api/people/spend.test.ts`: child spend goes to the root
Owner. `integration/api/locations/detail.test.ts`: one row per User.

## 5. Require Authors And Retire Stored Actors

- [ ] Add the `NOT VALID` check for new user Message rows (`design.md`,
      Schema). Every worker sets the author since step 2 release B.
- [ ] `resolveEventActorIdentityId` keeps author inference only for legacy
      reads.
- [ ] Retire `StoredSlackActor` in `Conversation` and in Redis work state
      (`task-execution/state.ts`). Store the Identity id.
- [ ] Guardian `actionActor` and `messageAuthor` use the stored author
      Identity for human and bot authors. Labels still come from the Actor
      and Message provenance, through `sameActorIdentity`. They never compare
      Identity ids alone (`design.md`, Guardian Labels).
- [ ] Remove `sessionLogActor` and the Source guess in
      `recordConversationActivityMetadata`.
- [ ] Add the Identity `kind` and `provider` to the dashboard
      `actorIdentitySchema`, and the `userId` when the Identity links a User.
      The client groups authors by User.

Backfill: none. The check is `NOT VALID`, so legacy rows stay.

Risk: medium. A missed ingress path now fails its write. Check the step 2
fallback logs before this step ships.

Verify: `component/conversation-sql-store.test.ts`: a user Message with no
author fails, and an assistant Message with no author succeeds.
`unit/guardian/gate.test.ts`: a web Actor reaches Guardian as web.
`agent-invocations` coverage: a system author that is not the Turn Actor is
labeled `event`, not `automation`.

## 6. Stop Using The Old Columns

This is release N for `actor_identity_id` and `actor_json`. Ship it after
step 4b and step 5.

- [ ] Stop writing `actor_identity_id`: the insert value, the `coalesce`
      update, and the `returning` read in `upsertConversation`.
- [ ] Stop writing `actor_json`: remove `actor: null` from the insert in
      `upsertConversation`.
- [ ] Remove the `actor_json` guard in `conversationFromRow` and the
      `actor_json` predicate in `sql/purge.ts`. First count rows where
      `actor_json is not null`.
- [ ] Leave both columns out of `conversationReadColumns()`.
- [ ] Remove every reader of `junior_conversations_actor_activity_idx`.

Backfill: none.

Risk: low, if no worker from before step 4b still runs.

Verify: the existing scenarios of steps 4b and 5 still pass.

## 7. Drop Old Columns And Fallbacks

This is release N+1 for all four columns.

- [ ] Remove `actor_identity_id`, `creator_identity_id`,
      `credential_subject_identity_id`, `actor_json`, and
      `junior_conversations_actor_activity_idx` from the Drizzle schema.
      Generate the drop migration.
- [ ] Remove the legacy fallbacks after the Turn cursor and mailbox retention
      window.
- [ ] Move the durable rules out of this plan: the Owner and child rules to
      `chat/conversations/README.md`, and the one system Identity and the
      author rule to `chat/identities/README.md`.
- [ ] Delete this plan.

Backfill: none.

Risk: low, if no worker from before step 6 still runs.

Verify: schema generation and migration metadata checks.
