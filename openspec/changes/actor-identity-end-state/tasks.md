# Tasks

Each step ships on its own. Each step leaves `main` correct.

## Dependencies

- Merge #2441 before step 2. Both change `SqlStore.recordExecution` and
  `task-execution/turn-cursor.ts`.
- Merge #2382 before step 4. Both add a `junior_conversations` column and
  change the write rule in `SqlStore.upsertConversation`. Step 4 uses the same
  child rule as #2382: a child stores no value and reads its root.
- Merge #2181 before step 5. Step 5 moves `agent-invocations/root-conversation.ts`
  and Guardian to Identity ids, and #2181 changes the same code. `onBehalfOf`
  stays provenance. It does not set the Owner.
- Merge #2260 (stacked on #2217) before step 3. Step 3 builds event authors on
  its `doneBy.subjectId`, and #2260 also changes Guardian and event ingress.
  Its Watch requester is provenance. The Event Turn still runs as the system
  Actor.
- #2211 owns the record of which Automation or dispatch did the work. This plan
  reads that record for provenance. It does not add a second system Identity.

## 1. One Actor To Identity Mapping (#2443)

- [ ] `chat/identities/actor.ts` owns the mapping from Actor to Identity.
- [ ] Remove the copies in `sql/event-actor.ts`, `handlers/oauth-callback.ts`,
      and the #2437 helper.
- [ ] No schema change.

## 2. Carry The Identity Id Through Read And Write

- [ ] Add `actorIdentityId` next to `actor` on the Turn cursor and on the
      mailbox delivery. Do not add it inside `Actor`.
- [ ] Each ingress resolves the Identity one time: Slack, web, fork, event,
      scheduled automation, event automation, plugin dispatch, local CLI, and
      Agent invocation.
- [ ] Every ingress sets `authorIdentityId` on each new user Message.
      Assistant output keeps no author.
- [ ] Add `ownerIdentityId` to `Conversation`. Until step 4, it reads
      `actor_identity_id`. `conversationFromRow` reads it from the row, also
      for a system Identity.
- [ ] `SqlStore.upsertConversation` writes the stored id. It does not derive an
      Identity from the Source again. Remove `systemIdentityFromSource` from the
      write path.
- [ ] Keep the legacy fallbacks for rows with no id. Log each time one runs.
- [ ] No schema change.

## 3. One System Identity And The Signed-In Web Identity

- [ ] Map every `SystemActor` and every `LocalActor` to one system Identity.
      Keep `SystemActor.name` as provenance.
- [ ] Map a web Actor to the viewer's `google` Identity. Never fall back to the
      system Identity.
- [ ] The mock viewer creates a mock Identity. Proposal: the local auth bypass
      does the same.
- [ ] Map a Slack bot author to its own Identity: provider `slack`, subject
      the bot id, no User. Proposal: add a `bot` Identity kind.
- [ ] Event authors (proposal in Event Authors): add `hasActor` to
      `pluginEventDeclarationSchema` and `isBot` to `doneBy`. Each plugin sets
      them. Core upserts the author Identity from `doneBy.subjectId` with no
      email. Events without an actor use the system Identity.
- [ ] Stop writing the `scheduler`, `local-cli`, and `event` system rows and the
      synthetic `junior/<email>` web rows.
- [ ] Migration: move references in `junior_conversations` and
      `junior_conversation_events` from the three system rows to the one system
      Identity. Delete the three rows.
- [ ] Migration: move references from each `junior/<email>` row to the `google`
      Identity of the same user. Keep rows that have no `google` match, and
      count them.

## 4. Add The Owner And Backfill It

This is the riskiest step. It changes access, the feed, People, and spend.

- [ ] Add `junior_conversations.owner_identity_id` and its index. Add the
      `NOT VALID` check that requires it on new root rows.
- [ ] `SqlStore.upsertConversation` sets the Owner at insert. The conflict
      update never changes it. Child rows store `null`.
- [ ] Write `actor_identity_id` too, until every reader moves.
- [ ] Before the backfill, run a dry-run count and post it on #2439:
  - root rows by Source and current Identity kind;
  - rows with a human Identity and a system Source (`scheduler`, `event`,
    `plugin`, `local`);
  - root rows with no Identity;
  - child rows with an Identity that differs from their root (their spend
    moves to the root Owner);
  - `junior/<email>` rows that are still referenced.
- [ ] Backfill the Owner:
  - Slack, web, and fork roots: copy `actor_identity_id`.
  - Roots with a system Source: the one system Identity.
  - Child rows: `null`.
- [ ] Backfill participant rows. Add a participant row for each human whose
      Identity was the root Identity and is no longer the Owner. Then that
      human keeps access and feed membership.
- [ ] Move every reader in the proposal table to `owner_identity_id`. Read the
      root Owner in `api/people/shared.ts` and `api/code/overview.ts`.
- [ ] State the behavior changes in the PR: automation-run spend leaves
      personal spend, and a human who replies to an automation Conversation is
      a participant, not the Owner.

## 5. Require Message Authors And Retire Stored Actors

- [ ] Add the `NOT VALID` check that requires `actor_identity_id` on new user
      Message rows: `type` is `message` or `message_updated`, and
      `payload->>'role'` is `user`. The proposal has the exact SQL. Slack bot
      Messages use the bot Identity.
- [ ] Remove author inference from `resolveEventActorIdentityId`. Keep it only
      for legacy reads.
- [ ] Retire `StoredSlackActor` in `Conversation` and in Redis work state
      (`task-execution/state.ts`). Store the Identity id.
- [ ] Move Guardian `actionActor` and `messageAuthor` in
      `agent-invocations/root-conversation.ts` to Identity ids.
- [ ] Remove `sessionLogActor` and `recordConversationActivityMetadata`
      Identity guesses in `task-execution/turn-cursor.ts`.

## 6. Drop Old Columns And Fallbacks

- [ ] Drop `actor_identity_id`, `creator_identity_id`,
      `credential_subject_identity_id`, and `actor_json` from
      `junior_conversations`. Do this one release after step 4, so no old
      worker still writes them.
- [ ] Remove the `actor_json` guard in `conversationFromRow` and the
      `actor_json` predicate in `sql/purge.ts`.
- [ ] Remove the legacy fallbacks after the Turn cursor and mailbox retention
      window.
- [ ] Update `TERMINOLOGY.md`, `chat/README.md`, `chat/conversations/README.md`,
      and `chat/identities/README.md`.
- [ ] Delete this plan.

## Verification

- [ ] Integration test: a scheduled automation Conversation keeps the system
      Owner after a human replies. The human gets participant access.
- [ ] Integration test: a child Conversation reads the root Owner for access.
- [ ] Component test: the store never changes `owner_identity_id` after insert.
- [ ] Migration checks only. Do not add tests for migration SQL.
