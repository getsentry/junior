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
- A dry run comes before each migration or repair. Post its counts on #2439.
- Migrate an old data shape only when special code exists because of it,
  and only with a rule that the dry run proves. Then delete that code
  (`design.md`, Legacy Data).

## Dependencies

- #2260 (stacked on #2217) before step 4. Step 4 builds event authors and
  the trust rule on #2260's event author. #2260's Watch requester is
  provenance, not an Owner.
- #2181 before step 8. Both change root Conversation Message authors and
  Guardian.
- #2211 owns the record of which Automation or dispatch did the work.
- Step order: 1, 2, 3, 4, 5, 6, 7, 8, 9.
  - Step 5 needs steps 2, 3, and 4 on every worker, so that no worker still
    writes an old data shape.
  - Step 6 and step 7 need David's OK on the step 5 counts.
  - Step 8 needs step 6, and 14 days after step 2 runs on every worker.
    Then no Redis entry without an Identity id is left.
  - Step 9 needs step 8 on every worker.

## 1. One Actor To Identity Mapping

Built in #2443 (merged).

- **Goal:** one place maps an Actor to its Identity.
- **Done when:** every caller uses that place, and every system and local
  Actor maps to the one system Identity. Legacy per-name system rows stay
  only for Conversations with no Actor, so the dashboard labels do not
  change.
- **Constraints:** no schema change and no backfill.

## 2. Carry The Identity Id

The readers are in #2473 (merged). The writers are in #2482 (in review).
Finish #2482.

- **Goal:** each ingress resolves the author Identity one time and carries
  its id with the work.
- **Done when:**
  - every ingress path sets the author Identity id on the Turn, the mailbox
    entry, and each new user Message. Assistant output sets none.
  - the Conversation write uses the stored id and keeps the first value. A
    human reply cannot replace the Owner of a system root.
  - the system Identity has the fixed id `system`.
  - fallbacks stay for rows and entries with no id, and each fallback logs.
- **Constraints:**
  - the Identity id travels next to the Actor, never inside it.
  - the writers ship only after #2473 runs on every worker. Old workers
    reject unknown fields in closed schemas.
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
  - **Readers first.** One PR is not safe:
    - The Inbound message schema is strict. The Slack, web, Agent
      invocation, and plugin dispatch kinds of `input.metadata` are strict
      too. Old code rejects the id on the entry and in its metadata.
    - The mailbox is in shared Redis. Vercel Queues sends a queue message
      only to the deployment that sent it, but this does not stop an old
      worker from reading a new mailbox entry.
    - During a deploy, an old worker can still run a Turn while new code
      adds a steering message to the same Conversation. After that, the old
      worker cannot read the Conversation execution. Its lease check-in,
      mailbox drain, and completion fail, so its Turn cannot finish.
    - The Turn checkpoint and the Message event are safe. An old worker
      drops an unknown Turn checkpoint field when it rewrites the
      checkpoint. The Message event field is already on `main`.
- **Plan choices for the writers. David has not confirmed these.**
  - Each fallback logs only when an id is missing: a new user Message, a new
    root Conversation with no Owner id, or a Turn checkpoint that resumes
    with no `actorIdentityId`.
  - The system Identity is the author of the task Message that a parent
    agent writes in a child Conversation, and of the result Message that a
    child sends back. An agent wrote the text, and its provenance has no
    Actor, so it never counts as user intent.

## 3. System Labels, Owner Name, And Root Owner Readers

- **Goal:** the Owner has one name, one place, and one rule for every
  reader.
- **Done when:**
  - the dashboard takes system root labels from the Conversation Source, or
    from the Automation or dispatch record. No visible label changes to
    "System".
  - new system Conversations use the `system` Identity. Junior writes no new
    per-name system rows.
  - code and docs call `junior_conversations.actor_identity_id` the Owner.
    The Conversation exposes its Owner. The column keeps its name.
  - every reader of the Owner uses the root Owner: access, the feed, People,
    spend, and Locations. Child spend rolls up to the root Owner.
  - Locations group by User, with the Identity as fallback.
  - children stop storing an Owner.
  - nothing writes or reads the two unused Conversation Identity columns.
  - the PR states the behavior changes (`proposal.md`).
- **Constraints:**
  - the root Owner readers ship in a release before children stop storing
    an Owner.
  - the labels ship before or with the change that stops the per-name
    system rows.
  - no backfill. Old child copies and old system rows stay until step 6.
- **Decide in this step:** the name of the Owner field in code, and the
  label source for each system Source.

## 4. Real Identities And Trust

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
  - Cursor Bugbot and Sentry's GitHub bot are on `trustedAuthors` in the
    deployed app config, in the same release as the trust rule.
- **Constraints:**
  - needs #2260.
  - core gets only a provider-neutral trusted result. Core reads no GitHub
    logins (`policies/provider-boundaries.md`).
  - Guardian labels come from the Actor and provenance, never from the
    Identity id alone.
  - the event author is never the Turn Actor. Turn credentials come only from
    the Watch or the Automation grant.
  - old `junior/<email>` rows stay. They need no migration.
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
  - the exact Bugbot and Sentry logins, from real event senders.

## 5. Dry Run

- **Goal:** prove each migration and repair rule on production data before
  any write.
- **Done when:**
  - a read-only dry run counts each old data shape in `design.md`, Legacy
    Data, and each Owner repair rule in `design.md`, Owner Repair.
  - it counts the old user Messages whose author it cannot prove, to
    confirm that they are uncommon.
  - it counts the rows that each rule would change, and the rows where a
    rule disagrees with rows that were not damaged.
  - the counts are posted on #2439, and David gives his OK.
- **Constraints:**
  - needs steps 2, 3, and 4 on every worker.
  - read-only. It writes nothing.
  - a rule that the counts do not prove is dropped. Its rows stay as they
    are.
- **Decide in this step:** the queries, and the rule for each old user
  Message author.

## 6. Data Migration

- **Goal:** each old data shape with special code moves to the new shape,
  in one release.
- **Done when:**
  - old event Messages have the system Identity as their author.
  - old user Messages have their author where the dry run proved the rule.
    The others stay with no author.
  - the author id copy in Message payloads is on the event column only.
  - the stored Actor JSON on Conversations is gone where the dry run proved
    the rule.
  - the per-name system rows are merged into the `system` Identity. No row
    that still has a reference is deleted.
  - child Conversations have no Owner copy.
- **Constraints:**
  - only the rules that the dry run proved, and only after David's OK.
  - safe under a rolling deploy. No worker still writes the old shapes.
  - the migration reads the foreign keys from the database, not from this
    plan.
- **Decide in this step:** the migration SQL and its batches.

## 7. Owner Repair

- **Goal:** fix old Owner damage (#2431) where the dry run proved the rule.
- **Done when:**
  - roots with a system Source that a human took over have the `system`
    Owner again.
  - Slack and web roots with a system Owner are repaired only if the dry run
    proved that rule.
  - each human who loses the root keeps access as a participant.
  - the PR states the behavior changes (`proposal.md`).
- **Constraints:**
  - needs #2482 on every worker, so the damage has stopped.
  - only the rules that the dry run proved, and only after David's OK.
  - roots with a Source that the rules do not cover keep their Owner.
- **Decide in this step:** the repair SQL.

## 8. Delete Fallbacks And Retire Stored Actors

- **Goal:** no new user Message is written without an author, and no code
  stores or guesses a Slack-only Actor.
- **Done when:**
  - the legacy fallbacks and the special code for each migrated shape are
    gone.
  - enforcement for new user Message rows and new root Owners is live.
    Assistant Messages need no author.
  - Conversations and Redis work state store the Identity id, not a stored
    Slack-shaped Actor.
  - Guardian sees web Actors as web and uses the stored author for human and
    bot authors. Labels still come from the Actor and provenance.
  - session logs and activity metadata stop guessing the Actor and Source.
  - the dashboard author shape shows the Identity kind and provider, and the
    User when there is one. The client groups authors by User. A Message
    with no author shows no author.
- **Constraints:**
  - needs #2181 and step 6.
  - ships 14 days after step 2 runs on every worker. Redis work state
    expires after 7 days.
  - the Redis readers stop needing the stored Actor in a release before the
    writers stop writing it.
  - check the step 2 fallback logs before this step ships. A missed ingress
    path now fails its write.
- **Decide in this step:** the enforcement, the Guardian changes, and the
  dashboard schema.

## 9. Drop Old Columns And Delete The Plan

- **Goal:** the schema is normalized.
- **Done when:**
  - the two unused Conversation Identity columns and the stored Actor JSON
    are gone.
  - the durable rules live beside the owning code: the Owner and child rules
    in the Conversations README, and the system Identity and author rule in
    the Identities README.
  - this plan is deleted.
- **Constraints:** ships one release after step 8 runs on every worker.
