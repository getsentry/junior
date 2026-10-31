# Tasks

## How To Use This Plan

- This plan fixes the target and the rules. It does not fix the
  implementation.
- At the start of each step, re-check this plan against current `main`.
  Code can change between steps.
- Settle the implementation details of the step in its PR. The "Decide in
  this step" bullets list the open details.
- When the target or a rule must change, update this plan in the same PR.
  A change to a decided rule (`proposal.md`, From David Cramer and Plan
  Decisions) needs David's OK.
- Follow `policies/testing.md`. Extend the owning scenario. Do not add tests
  for migration SQL.

## Release Rules

- Each step ships alone and leaves `main` correct.
- Each step is safe under a rolling deploy. Old and new workers run at the
  same time, and `junior upgrade` runs migrations while old workers run.
- Readers ship before writers. A new field ships in a release that accepts it
  before any release writes it.
- Enforcement ships only after every writer sets the value. It does not apply
  to legacy rows.
- A column drop ships one release after the code stops using the column.
- No production backfill runs without explicit approval.
- A dry run comes before each repair or merge. Post its counts on #2439.

## Dependencies

- #2441 before the step 2 writers. Both change the Conversation write and
  the Turn checkpoint. The step 2 readers do not change the Conversation
  write.
- #2260 (stacked on #2217) before step 3. Step 3 builds event authors and
  the trust rule on #2260's event author. #2260's Watch requester is
  provenance, not an Owner.
- #2382 before step 4a. Both change the Conversation row and its write rule.
- #2181 before step 5. Both change root Conversation Message authors and
  Guardian.
- #2211 owns the record of which Automation or dispatch did the work.
- Step order: 1, 2, 3, 4a, 4b, 5, 6, 7. Step 4b needs 4a on every worker.
  Step 6 needs 4b and 5. Step 7 needs 6 on every worker.

## 1. One Actor To Identity Mapping

Built in #2443 (merged).

- **Goal:** one place maps an Actor to its Identity.
- **Done when:** every caller uses that place, and every system and local
  Actor maps to the one system Identity. Legacy per-name system rows stay
  only for Conversations with no Actor, so the dashboard labels do not
  change.
- **Constraints:** no schema change and no backfill.

## 2. Carry The Identity Id

- **Goal:** each ingress resolves the author Identity one time and carries
  its id with the work.
- **Done when:**
  - every ingress path sets the author Identity id on the Turn, the mailbox
    entry, and each new user Message. Assistant output sets none.
  - the Conversation write uses the stored id and no longer guesses an
    Identity from the Source. A human reply cannot replace the Identity of a
    system root.
  - the Conversation exposes its Owner. Until step 4b, the Owner reads the
    old Conversation Identity column.
  - nothing writes or reads the two unused Conversation Identity columns.
  - legacy fallbacks stay for rows with no id, and each fallback logs.
- **Constraints:**
  - the Identity id travels next to the Actor, never inside it.
  - the reader release ships before the writer release. Old workers reject
    unknown fields in closed schemas.
  - ingress paths: Slack, web, fork, event, scheduled automation, event
    automation, plugin dispatch, local CLI, and Agent invocation.
- **Decided in this step:**
  - **Field names.** Each name matches the words already on its record.
    - Inbound message: `input.authorIdentityId`, next to `input.authorId`.
    - Message event: `authorIdentityId`, already on `main`. SQL stores it
      in `junior_conversation_events.actor_identity_id`.
    - Turn checkpoint: `actorIdentityId`, next to `actor`. It is the
      Identity of the Turn Actor. For an event Turn, that is the system
      Identity, not the event author.
  - **Readers first.** #2473 adds the readers. The writers ship in a later
    PR, after #2473 runs on every worker. One PR is not safe:
    - The Inbound message schema is strict. The Slack, web, Agent
      invocation, and plugin dispatch kinds of `input.metadata` are strict
      too. Old code rejects the id on the entry and in its metadata.
    - The mailbox is in shared Redis. Vercel Queues sends a queue message
      only to the deployment that sent it, but this does not stop an old
      worker from reading a new mailbox entry.
    - During a deploy, an old worker can still run a Turn while new code
      adds a steering message to the same Conversation. After that, the old
      worker cannot read the Conversation execution
      (`normalizeExecution` in `task-execution/state.ts`). Its lease
      check-in, mailbox drain, and completion fail, so its Turn cannot
      finish.
    - The Turn checkpoint and the Message event are safe. An old worker
      drops an unknown Turn checkpoint field when it rewrites the
      checkpoint. The Message event field is already on `main`.
- **Plan choices for the writers. David has not confirmed these.**
  - The fallback logs ship with the writers. Each one logs only when an id
    is missing:
    - a new user Message with no `authorIdentityId`. The event write still
      guesses the author (`resolveEventActorIdentityId`).
    - a new root Conversation with no Owner id. The write still uses the
      Actor or the legacy Source row (`resolveConversationActorIdentityId`).
    - a Turn checkpoint with no `actorIdentityId` when a Turn resumes.
  - The system Identity is the author of the task Message that a parent
    agent writes in a child Conversation, and of the result Message that a
    child sends back. An agent wrote the text, and its provenance has no
    Actor, so it never counts as user intent.

## 3. One System Identity And Real Identities

- **Goal:** every author gets its real Identity, and the trust rule decides
  which event authors can start a run.
- **Done when:**
  - web Actors use their sign-in Identity. Junior writes no new
    `junior/<email>` rows. A web Actor never falls back to the system
    Identity.
  - the mock viewer has an in-memory mock Identity. The local auth bypass
    has an Identity that cannot match a production User.
  - a bot has its own Identity of kind `bot` and no User.
  - an event Message author is the Identity of the person or bot who wrote
    it, or the system Identity for a system event. An event write never
    changes the `kind` or the User of an existing Identity. An event can
    name an author only on its own provider.
  - event authors do not become participants. The participant list shows
    only `user` Identities with a User.
  - the trust rule is live (`design.md`, Trust). Trusted text counts like a
    chat message from that author. An event from an untrusted or unknown
    author does not start a run. Junior drops it before it joins a batch or
    a Turn, so the agent never sees it. A system event runs as today.
  - event Turns still run as the system Actor. The event author labels the
    Message and feeds the trust check, and gives no credentials
    (`design.md`, Why The Event Author Is Not The Turn Actor).
  - `trustedAuthors` is documented for the GitHub plugin, with the warning
    about reused logins.
  - the dashboard takes system root labels from the Source or the
    Automation or dispatch record. No visible label changes to "System".
  - after the dry run and approval, legacy system rows merge into the one
    system Identity. `junior/<email>` references move only where the merge
    is clearly correct (`proposal.md`, Plan Decisions).
- **Constraints:**
  - needs #2260.
  - core gets only a provider-neutral trusted result. Core reads no GitHub
    logins (`policies/provider-boundaries.md`).
  - Guardian labels come from the Actor and provenance, never from the
    Identity id alone.
  - the event author is never the Turn Actor. Turn credentials come only from
    the Watch or the Automation grant.
  - the merge runs in a later release than the code change, when no worker
    writes the old keys. It reads the foreign keys from the database, not
    from this plan. It deletes no row that still has a reference.
- **Decide in this step:**
  - the identity keys for the mock viewer and the local auth bypass, and
    where the production guard for the bypass lives.
  - the Slack bot fallback when Slack sends no bot user id.
  - how a plugin reports the author account, the bot flag, and the trusted
    result to core.
  - how trusted text reaches the model and Guardian, and the Guardian label
    for a bot author.
  - the batch Message author. Current proposal: the shared author when every
    entry has the same one, else the system Identity.
  - where Junior drops untrusted authored events, so that none joins a batch
    or a Turn.
  - the default `trustedAuthors` entries, such as Cursor Bugbot
    (`proposal.md`, Open Questions, 1).

## 4a. Write The Owner

- **Goal:** each new root stores its Owner at insert.
- **Done when:** a new root has its Owner, a reply never changes it, and a
  child stores none. The old column is still written. No reader moves yet.
- **Constraints:** needs #2382. No enforcement and no backfill yet. Old
  workers can still insert roots with no Owner.
- **Decide in this step:** the column, the index, and the write rule.

## 4b. Backfill, Enforce, And Read The Owner

This is the riskiest step. It changes access, the feed, People, and spend.

- **Goal:** every root has an Owner, and every reader uses it.
- **Done when:**
  - every root has an Owner, from the rules in `design.md`, Owner and Owner
    Repair. Child rows store none.
  - enforcement for new root rows is live.
  - every reader of the old Conversation Identity column uses the Owner.
  - child spend rolls up to the root Owner.
  - Locations group by User, with the Identity as fallback.
  - each human who loses the root keeps access as a participant.
  - the PR states the behavior changes (`proposal.md`).
- **Constraints:**
  - ships after step 4a runs on every worker.
  - dry run first, posted on #2439. The backfill needs explicit approval.
  - roots with a Source that the rules do not cover wait until the dry run
    is reviewed.
  - one disagreement in the Owner repair check drops the repair.
- **Decide in this step:** the dry-run queries, the backfill SQL, the
  enforcement, and the reader list. Confirm or drop the Owner repair
  proposal.

## 5. Require Authors And Retire Stored Actors

- **Goal:** no new user Message is written without an author, and no code
  stores or guesses a Slack-only Actor.
- **Done when:**
  - enforcement for new user Message rows is live. Assistant Messages need
    no author.
  - author inference stays only for legacy reads.
  - Conversations and Redis work state store the Identity id, not a stored
    Actor.
  - Guardian sees web Actors as web and uses the stored author for human and
    bot authors. Labels still come from the Actor and provenance.
  - session logs and activity metadata stop guessing the Actor and Source.
  - the dashboard author shape shows the Identity kind and provider, and the
    User when there is one. The client groups authors by User.
- **Constraints:** needs #2181. Check the step 2 fallback logs before this
  step ships. A missed ingress path now fails its write.
- **Decide in this step:** the enforcement, the Guardian changes, and the
  dashboard schema.

## 6. Stop Using The Old Columns

- **Goal:** no code reads or writes the old Conversation Identity column or
  the stored Actor JSON.
- **Done when:** no write, read, purge rule, or index use refers to them.
- **Constraints:** ships after steps 4b and 5. Count rows with stored Actor
  JSON before its readers go.
- **Decide in this step:** the list of uses, from current `main`.

## 7. Drop Old Columns And Fallbacks

- **Goal:** the schema is normalized.
- **Done when:**
  - the old Conversation Identity column, the two unused Identity columns,
    the stored Actor JSON, and their index are gone.
  - the legacy fallbacks are gone, after the Turn cursor and mailbox
    retention window.
  - the durable rules live beside the owning code: the Owner and child rules
    in the Conversations README, and the system Identity and author rule in
    the Identities README.
  - this plan is deleted.
- **Constraints:** ships after step 6 runs on every worker.
- **Decide in this step:** when the retention window has passed.
