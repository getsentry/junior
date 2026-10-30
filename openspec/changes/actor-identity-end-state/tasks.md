# Tasks

Each step ships on its own and leaves `main` correct. Test paths are under
`packages/junior/tests/`. Extend the owning scenario in each listed file. Do
not add tests for migration SQL.

## Dependencies

- #2441 before step 2. Both change `SqlStore.recordExecution` and
  `task-execution/turn-cursor.ts`.
- #2260 (stacked on #2217) before step 3. Step 3 builds event authors on its
  `doneBy.subjectId`, and widens its rule for which event text counts as
  instructions. Its Watch requester is provenance, not an Owner.
- #2382 before step 4. Both add a `junior_conversations` column and change the
  write rule in `SqlStore.upsertConversation`.
- #2181 before step 5. Both change `agent-invocations/root-conversation.ts` and
  Guardian.
- #2211 owns the record of which Automation or dispatch did the work.

## 1. One Actor To Identity Mapping (#2443)

- [ ] `chat/identities/actor.ts` owns the mapping from Actor to Identity.
- [ ] Remove the copies in `sql/event-actor.ts`, `handlers/oauth-callback.ts`,
      and `plugins/viewer.ts`.

Backfill: none. No schema change.

Risk: low. It moves code. A mapping change would move rows to new Identities.

Verify: the actor mapping unit test that #2443 adds, and
`integration/oauth-identity-link.test.ts`.

## 2. Carry The Identity Id

- [ ] Release A: the mailbox entry (`inboundMessageSchema`) and the Turn
      cursor accept an optional `actorIdentityId` next to `actor`.
- [ ] Release B: each ingress resolves the Identity one time and sets
      `actorIdentityId`. Ingress paths: Slack, web, fork, event, scheduled
      automation, event automation, plugin dispatch, local CLI, and Agent
      invocation.
- [ ] Each ingress sets `authorIdentityId` on each new user Message.
      Assistant output sets no author.
- [ ] Add `ownerIdentityId` to `Conversation`. Until step 4 it reads
      `actor_identity_id`. `conversationFromRow` returns it for every
      Identity kind, also system.
- [ ] `SqlStore.upsertConversation` writes the stored id. Remove
      `systemIdentityFromSource` and `mergeActor` from the write path.
- [ ] Stop writing `creator_identity_id` and `credential_subject_identity_id`.
- [ ] Keep the legacy fallbacks for rows with no id. Log each time one runs.

Backfill: none. No schema change.

Risk: medium. `inboundMessageSchema` is `.strict()`, so an old worker rejects
a mailbox entry with the new field. Release A must deploy before release B.

Verify: `component/conversation-sql-store.test.ts`: a system root keeps its
Identity after a human Turn writes. `integration/conversation-turn-work.test.ts`:
a web Turn stores its author Identity.

## 3. One System Identity And Real Identities

- [ ] Map every `SystemActor` and every `LocalActor` to one system Identity.
      Keep `SystemActor.name` as provenance.
- [ ] Map a web Actor to the viewer's `google` Identity. Never fall back to the
      system Identity.
- [ ] Give the mock viewer a mock Identity. Proposal 2: give the local auth
      bypass one too.
- [ ] Map a Slack bot author to its own Identity with no User. Proposal 1: use
      kind `bot`.
- [ ] Event authors, per Proposals 3 to 6: plugins set `hasActor` and
      `doneBy.subjectId` and `isBot`. Core upserts the author Identity with
      no email. Other events use the system Identity.
- [ ] Event authors do not become participants. `sql/history.ts` skips
      `recordConversationParticipant` for event Messages.
- [ ] Event author trust (`proposal.md`, Plan Decisions). The GitHub plugin
      gets `githubPlugin({ trustedAuthors })`, a trusted authors list of
      GitHub logins. It compares logins without case (Proposal 7). It sets
      `doneBy.trusted` when the event login is on the list (Proposal 4).
      Core treats the text as instructions only when `doneBy.trusted` is
      `true`, or when the author's `github` Identity links to a User whose
      primary email passes `allowedDomains`. All other event text stays in
      `untrustedText`. Core reads no GitHub login for this.
- [ ] Document `trustedAuthors` in `junior-github/SETUP.md` and say to list
      bot logins.
- [ ] The participant list shows only Identities of kind `user` with a User,
      the same rule as participant rows.
- [ ] Stop writing the `scheduler`, `local-cli`, `event`, and `junior/<email>`
      rows.

Backfill: move references in `junior_conversations` and
`junior_conversation_events` from the three system rows to the one system
Identity, then delete the three rows. Move references from a `junior/<email>`
row to a `google` row only when both rows link the same `user_id`. Leave
every other `junior/<email>` row and reference as it is.

Risk: medium. Wrong merges move Conversations between People. Run each
migration as a dry-run count first. The trust rule changes which event text
Junior follows. Only logins on the trusted authors list and linked Users on
an allowed domain gain this.

Verify: `component/identity-read.test.ts`,
`integration/api/conversations/detail.test.ts` (participants),
`integration/local-agent-runner.test.ts`, and the review and comment scenario in
`packages/junior-github/tests/webhook-outcomes.test.ts`: a bot on the trusted
authors list is trusted, a bot that is not on the list is data only, and the
commenter gets no participant row.

## 4. Add The Owner

This is the riskiest step. It changes access, the feed, People, and spend.

- [ ] Add `junior_conversations.owner_identity_id` and its index. Add the
      `NOT VALID` check for new root rows (`design.md`, Schema).
- [ ] `SqlStore.upsertConversation` sets the Owner at insert. The conflict
      update never changes it. Child rows store `null`.
- [ ] Keep writing `actor_identity_id` until every reader moves.
- [ ] Move every reader in `design.md`, Readers, to the Owner.
- [ ] Proposal 9: `api/locations/query.ts` groups actors by User.
- [ ] Drop `creator_identity_id` and `credential_subject_identity_id`. Step 2
      stopped all writes one release earlier.
- [ ] State the behavior changes in the PR (`proposal.md`).

Backfill:

1. Run a dry-run count and post it on #2439:
   - root rows by Source and Identity kind;
   - roots with a `slack` or `web` Source and a system Identity;
   - roots with a human Identity and a system Source (`scheduler`, `event`,
     `plugin`, `local`);
   - roots with no Identity;
   - child rows whose Identity differs from their root;
   - `junior/<email>` rows that are still referenced. Step 4 does not change
     them.
2. Roots with a `slack` or `web` Source: copy `actor_identity_id`. Proposal 8:
   when it is a system Identity and the first user Message author is kind
   `user` with a User, use that author. Otherwise copy the current Identity.
3. Roots with a system Source: the system Identity.
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
      Schema).
- [ ] `resolveEventActorIdentityId` keeps author inference only for legacy
      reads.
- [ ] Retire `StoredSlackActor` in `Conversation` and in Redis work state
      (`task-execution/state.ts`). Store the Identity id.
- [ ] Guardian `actionActor` and `messageAuthor` read Identity ids. The
      event author trust rule from step 3 does not change.
- [ ] Remove `sessionLogActor` and the Source guess in
      `recordConversationActivityMetadata`.
- [ ] Proposal 10: add the Identity `kind` and `provider` to the dashboard
      `actorIdentitySchema`.

Backfill: none. The check is `NOT VALID`, so legacy rows stay.

Risk: medium. A missed ingress path now fails its write. Check the step 2
fallback logs before this step ships.

Verify: `component/conversation-sql-store.test.ts`: a user Message with no
author fails, and an assistant Message with no author succeeds.
`unit/guardian/gate.test.ts`: a web Actor reaches Guardian as web.

## 6. Drop Old Columns And Fallbacks

- [ ] Drop `actor_identity_id` and `actor_json` from `junior_conversations`.
      Do this one release after step 4.
- [ ] Remove the `actor_json` guard in `conversationFromRow` and the
      `actor_json` predicate in `sql/purge.ts`.
- [ ] Remove the legacy fallbacks after the Turn cursor and mailbox retention
      window.
- [ ] Move the durable rules out of this plan: the Owner and child rules to
      `chat/conversations/README.md`, and the one system Identity and the
      author rule to `chat/identities/README.md`.
- [ ] Delete this plan.

Backfill: none.

Risk: low, if no worker from before step 4 still runs.

Verify: schema generation and migration metadata checks.
