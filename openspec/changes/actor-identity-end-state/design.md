# Design

`proposal.md` says who decided each item and what is still open. This file
gives the model, the rules, and the known gaps. It does not fix the
implementation. Each step settles its own details in its PR (`tasks.md`, How
To Use This Plan). A detail marked "current proposal" is not decided.

## Model

### Owner

- The Owner is the Identity that started a root Conversation.
- Slack, web, and fork Conversations: the human who started it. A fork
  already makes the requester the Owner of the new root.
- Scheduled automations, event automations, plugin dispatch, and the local
  CLI: the system Identity.
- The Owner is the existing `junior_conversations.actor_identity_id` column.
  Code and docs call it the Owner. There is no new column and no rename.
- Junior sets the Owner at insert. No later write changes it. On `main`, the
  Conversation write still lets the newest value win. #2482 makes it keep
  the first value.
- An Automation has a creator (`TERMINOLOGY.md`). The creator is not the
  Owner of the Conversations that its runs create.

### Owner Repair

Owner repair (#2431) fixes wrong data. It is not a migration, because no
special code exists for the damaged rows. It is separate from the data
migration in Legacy Data.

Before #2436, the Conversation write could replace the human Identity of a
`slack` or `web` root with a system Identity. The same write can also replace
a system Identity, or one human Identity, with a later human Identity. So the
Owner of a root is not always its starter. Until #2482 runs on every worker,
this damage can keep happening.

Rules:

- Leave old rows as they are, unless a dry run proves the repair rule.
- Run a dry run first, and post its counts on #2439.
- Do not run a production backfill without explicit approval.
- When the dry run shows that a rule disagrees with rows that were not
  damaged, drop that rule. Then those rows keep their current Owner.
- Each human who loses the root keeps access as a participant.
- Roots with any other Source keep their current Owner until the dry run is
  reviewed.

The rules to prove:

- **System Source taken over by a human.** A root with a system Source
  (`scheduler`, `event`, or `local`) and a human Owner today goes back to the
  `system` Identity. This is provable, because the Source is set-once.
- **Slack or web root with a system Owner.** Current proposal. Junior repairs
  it only when the dry run proves the rule:
  - Repair only a root that is not a fork, has a `slack` or `web` Source, and
    has a system Owner today.
  - The repaired Owner is the author of the first human user Message. That
    author must be a person with a User that fits the Source.
  - Repair only roots with one author User across their human user Messages.
    Junior cannot pick the starter of a root with more than one human author.
  - Event Messages and bot Messages do not count as human user Messages.
    An event Turn is how many damaged roots got their system Identity, so
    these roots have event Messages.
  - Agreement check: on roots that have a `user` Owner today and one author
    User, count the rows where that author is a different User. One
    disagreement drops this rule.

### Child Conversations

- A child stores no Owner. It reads its root Owner.
- Today the Conversation write also copies an Owner onto child rows. Step 3
  stops this. The data migration clears the old copies.
- Access already reads the root Owner, not the child's own copy. #2382 uses
  the same rule for visibility.
- Child spend goes to the root Owner. Today spend reads the child's own copy.
- `onBehalfOf` (#2181) is Message provenance. It gives no access, spend, or
  feed rights.

### System Identity

- Junior has one system Identity. Every `SystemActor` and every `LocalActor`
  maps to it. No plugin and no OAuth link can write its key.
- "Which system" is provenance. It comes from the Conversation Source and the
  Automation or dispatch record (#2211). `SystemActor.name` stays in runtime
  code.
- #2443 (step 1) added the one entry point from an Actor to an Identity. It
  maps system and local Actors to the one system Identity. #2482 gives that
  Identity the fixed id `system`.
- Today a Conversation with no Actor still writes a legacy per-name system
  row (`scheduler`, `local-cli`, or `event`). The names of these rows are the
  root labels that the dashboard shows today ("Scheduler", "Local CLI",
  "Event").
- Rule: the dashboard labels come from the Conversation Source first. Then
  new system Conversations use `system`, and the data migration merges the
  legacy rows into it. No visible label may change to "System".

### Users And Identities

- A User is one person. A User has many Identities, for example a `slack`
  Identity, a dashboard sign-in Identity, and a `github` Identity from an
  OAuth link.
- Spend, People, participants, and Locations roll up by User. The Identity
  is the fallback only for an Identity with no User, such as a bot.
- A Message author and an Owner are Identities. A reader joins the Identity
  to its User to group.
- Legacy `junior/<email>` web Identities need no migration. Each one is a
  valid Identity that links to the right User, so readers that group by User
  show it correctly. A merge into the sign-in Identity is optional.

### Web Users

- A web Actor uses the Identity that dashboard sign-in saves for the viewer
  User. Today that is the `google` Identity. Junior stops writing the
  synthetic `junior/<email>` Identity.
- Old sessions need no invalidation. When this plan was written, sessions
  lasted at most 8 hours, and each sign-in since #2220 saves the `google`
  Identity. Re-check this in step 4.
- The mock viewer gets a mock Identity. Mock reporting writes no rows, so
  this Identity is in memory only.
- The local auth bypass: current proposal, to confirm in step 4. The bypass
  User gets a mock Identity that only the bypass writes. The dashboard
  refuses the bypass on a production deploy. Today only the example app
  refuses it.

### Bots

- A bot has an Identity of kind `bot` and no User.
- A Slack bot uses its bot user id (answer 11). The fallback when Slack sends
  no bot user id is decided in step 4.
- With no User, a bot never counts as a person in spend, People, or
  participants.

### Event Authors

- An event is a Message with role `user`. Its author is the Identity of the
  person or bot who wrote the content. An event with no author uses the
  system Identity. It is a system event, and it runs as today.
- An event never changes the Owner or the Turn Actor. Event Turns run as the
  system Actor, as on `main` today (`EVENT_SYSTEM_ACTOR` in
  `chat/events/actor.ts`).
- Junior still resolves the author to its Identity and, when there is one,
  its linked User. The author labels the Message and feeds the trust check.
  It gives no credentials, access, or spend.
- The author Identity is the same row that the OAuth link writes for that
  account. An event write never changes the `kind` or the User of an existing
  row. Today the Identity write changes `kind` on conflict, so step 4 must
  change this.
- An event can name an author only on its own provider. A core provider gets
  the system Identity. So a plugin cannot write an Identity for another
  provider.
- An event author never becomes a participant.
- Event automations write no event Message. They start an Automation run.
- An old event Message gets the system Identity as its author. Those Turns
  ran as system, and Junior never saved the real writer of a PR comment.

### Why The Event Author Is Not The Turn Actor

The Turn Actor decides whose credentials a Turn uses and whose work it is.
So the event author must never be the Turn Actor. The reason is the confused
deputy risk: Junior holds grants, and outside text must not make Junior use
those grants for someone who does not own them.

- An event carries text from outside Junior. If its author were the Turn
  Actor, that text could steer a run that holds a person's grants.
- The run could also pick up the grants of the User that the author maps to.
  A GitHub comment could then act with that person's Slack or GitHub
  credentials, without that person asking Junior for anything.
- It widens who can act through Junior. Today a person acts through Junior
  when they ask in chat, or when they create a Watch or an Automation. With
  the author as Turn Actor, each author who writes on a watched resource could
  act with their own grants, without asking Junior.
- A Turn's credentials come only from the grant of the Watch or the
  Automation, never from the event author.

This matches the current rules on `main`:

- Another Actor's message does not join an active Actor's credentialed work.
  The worker puts messages in one Turn only when their author and Source
  match (`selectContiguousTurnBatch` in
  `task-execution/attempt-selection.ts`). By default, another Actor's
  mid-run Slack ask waits for its own Turn (`JUNIOR_CROSS_ACTOR_MID_RUN_MODE`,
  `follow_up`).
- A system-acted event Turn uses the grants of a Watch creator only through
  `timerWatchCredentialSubject` (`chat/events/notification.ts`). It gives a
  credential subject only when every event in the batch has a valid subject
  for its own Watch, and all of them are the same User. Otherwise the Turn
  gets no user grant.

The trust rule does not change this. A trusted author's text counts like a
chat message from that author, but the Turn still runs as the system Actor
with the Watch or Automation grant.

### Trust

- An author is trusted when one of these is true:
  - Junior verifies their linked account, the same check that #2260 and
    #2217 use: the exact linked account id (never a handle or an email), one
    linked Slack user, a current human member, and a Slack email on
    `allowedDomains`;
  - the plugin says their login is on its trusted authors list. For GitHub,
    that is its `trustedAuthors` config. Logins compare without case.
- Every other author is untrusted. An unknown sender is never trusted. A
  deactivated employee with a linked account is not trusted.
- Text from a trusted author counts exactly like a chat message from that
  author.
- An event from an untrusted or unknown author does not start a run.
- Only the author's own text counts. Lines that the author only quotes do
  not.
- Core gets only a provider-neutral trusted result. Core does not read
  provider logins.
- The agent never sees an untrusted authored event. Junior decides trust for
  each event and drops an untrusted one before it joins a batch or a Turn.
- Only trusted and system entries are batched. When none is left, no Turn
  starts.
- Batch Message author: current proposal, to confirm in step 4. The shared
  author when every entry has the same one, else the system Identity.
- A system event can carry untrusted external text, such as check output.
  The current handling covers it, and this plan adds no rule. The event's
  `untrustedText` becomes external text in the task input, which says to use
  it as information, not instructions (`chat/events/notification.ts`; the
  task input sections in `chat/README.md`; `chat/events/README.md`). The
  instructions come from the Watch intent or the Automation instruction. The
  trusted summary and verified details are plugin facts, not instructions.

### Guardian Labels

- Guardian labels come from the Actor and Message provenance. They never come
  from the Identity id alone.
- With one system Identity, every system and CLI author has the same Identity
  id. An id compare would make every system author match the Turn Actor. The
  stored Identity only replaces the platform guess for human and bot authors.

### Message Authors

- Every new user Message has an author Identity:
  - a human uses their Identity;
  - a bot uses its bot Identity;
  - an event uses its author Identity or the system Identity;
  - a scheduled automation, a plugin dispatch, or the local CLI uses the
    system Identity.
- Assistant output is an event. It has no author Identity.
- Junior resolves the author at ingress. After step 8, a missing author
  fails the write.
- Until step 8, the fallbacks guess an author for a Message with no id, and
  they log. Step 8 deletes them.
- An old user Message whose author the dry run cannot prove stays with no
  author. Junior does not guess one, and it does not use the system
  Identity. A human Message stored as system could later read as a system or
  automation Message in history.

### Identity Id Placement

- The Identity id travels next to the Actor, never inside it. The `Actor`
  schema is closed, so a new field would make old workers and external
  plugins reject it.
- The Inbound message and the Message carry the author Identity id as
  `authorIdentityId`. The Turn carries the Identity id of its Actor as
  `actorIdentityId` (`tasks.md`, step 2).
- The Conversation carries the Owner.

## Storage Rules

- Each root Conversation stores its Owner in the existing Conversation
  Identity column. A child stores none.
- Enforcement that a new root has an Owner ships only after every writer sets
  it. It does not apply to legacy rows.
- Enforcement that a new user Message has an author ships only after every
  writer sets it. It does not apply to legacy rows.
- The two unused Conversation Identity columns and the stored Actor JSON go
  away. Each one goes only after no code uses it (`tasks.md`, Release Rules).
- Each step decides its own SQL, constraint text, and index names.

## Legacy Data

Rule: Junior migrates an old data shape only when special code exists
because of it, and only with a rule that a read-only dry run proves. Then
Junior deletes that code.

These shapes need the migration:

- The stored Actor JSON on Conversations (`actor_json`). Read and purge code
  still checks it.
- User Messages with no author Identity. The read and write fallbacks guess
  their author. An old event Message gets the system Identity. Another user
  Message gets an author only when the dry run proves the rule. Otherwise it
  stays with no author (Message Authors).
- The author Identity id copy in the Message payload. Read code still checks
  it.
- The per-name `scheduler`, `local-cli`, and `event` system rows. They merge
  into the one `system` Identity. The dashboard labels must come from the
  Conversation Source first.
- Owner copies on child Conversations.
- The two unused Conversation Identity columns (`creator_identity_id` and
  `credential_subject_identity_id`). Code writes them only as empty. The dry
  run confirms that they are empty, and a later release drops them.

These need no migration:

- Old `junior/<email>` web Identities (Users And Identities).
- Redis work state and Turn checkpoints. Junior waits for them to expire.
  Redis work state expires after 7 days. The plan waits 14 days.

The migration runs in a later release than the code change, when no worker
writes the old shapes. It reads the foreign keys from the database, not from
this plan. It deletes no row that still has a reference.

Owner repair is not in this list. It fixes wrong data, not a code path
(Owner Repair).

## Known Gaps

First checked against `main` at `c122def15`. Gaps 6, 7, 8, 10, 11, 16, and
the child spend gap were checked again at `e838c19`. Re-check each gap at the
start of the step that closes it. "Confirmed" means the cited code shows the
fault. "Traced" means the fault follows from a path through several files. No
gap was reproduced at runtime. No production data was queried.

No gap is fully fixed on `main`. #2436 fixed part of gap 10. #2437 fixed part
of gap 17. #2440 fixed part of gap 19. #2443 fixed part of gap 6. #2482 (in
review) closes gap 10 for new writes and fixes part of gap 7.

| #   | What breaks now                                                                                           | Where                                                                 | Step                          | Evidence  |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------- | --------- |
| 1   | No event Message has an author Identity. Core does not read the GitHub sender id.                         | `chat/events/notification.ts`, `junior-github/src/webhooks/events.ts` | 4; old Messages: 6            | Confirmed |
| 2   | Guardian sends every web Actor as local.                                                                  | `guardian/gate.ts`, `guardian/proposal.ts`                            | 8                             | Confirmed |
| 3   | Message authors in root Conversations come from the root Source or Location. A bot author gets no Actor.  | `agent-invocations/root-conversation.ts`                              | 8                             | Confirmed |
| 4   | Session logs drop every Actor that is not Slack.                                                          | `task-execution/turn-cursor.ts`                                       | 2, 8                          | Confirmed |
| 5   | Activity metadata guesses the Source. A web Turn with no saved Source gets `local`.                       | `task-execution/turn-cursor.ts`                                       | 8                             | Traced    |
| 6   | Event Message authors are guessed from id patterns and the Location, and web gets the synthetic Identity. | `chat/conversations/sql/event-actor.ts`                               | 2, 4, 6, 8                    | Confirmed |
| 7   | The participant list shows system Identities.                                                             | `api/conversations/participants.ts`                                   | 2, 4                          | Confirmed |
| 8   | Locations show a person with two Identities two times.                                                    | `api/locations/query.ts`                                              | 3                             | Confirmed |
| 9   | Connections are keyed per platform. A Slack connection does not show on the web.                          | `api/connections/routes.ts`                                           | Non-Goal                      | Confirmed |
| 10  | A later human Turn can replace the Owner of a system root. #2436 fixed only the Source case.              | `chat/conversations/sql/store.ts`, `sql/actor-identity.ts`            | 2; old damage: 7              | Confirmed |
| 11  | Legacy system Identity names do not match `SystemActor.name` values.                                      | `sql/actor-identity.ts`                                               | 3, 6                          | Confirmed |
| 12  | The local CLI uses one user id for every person and for its tokens.                                       | `chat/local/runner.ts`, `chat/local/credential-sync.ts`               | 4; naming the human: Non-Goal | Confirmed |
| 13  | The `Actor` schema is closed. A TODO questions the system platform value.                                 | `junior-plugin-api/src/schemas.ts`                                    | Non-Goal                      | Confirmed |
| 14  | The dashboard author shape is Slack only. It cannot show a system, bot, or GitHub author.                 | `api/schema/conversation.ts`                                          | 8                             | Confirmed |
| 15  | Conversations and Redis work state store a Slack-only Actor shape.                                        | `chat/conversations/store.ts`, `task-execution/state.ts`              | 6, 8, 9                       | Confirmed |
| 16  | Two Conversation Identity columns are always empty.                                                       | `chat/conversations/sql/store.ts`                                     | 3, 9                          | Confirmed |
| 17  | Web uses the synthetic `junior/<email>` Identity. The mock viewer and the local bypass have none.         | `sql/actor-identity.ts`, `junior-dashboard/src/app.ts`                | 4; old rows: no migration     | Confirmed |
| 18  | No rule checks if an event author is a verified person before Junior follows their text.                  | `agent-invocations/root-conversation.ts`, `guardian/policy.ts`        | 4                             | Traced    |
| 19  | Old rows: roots whose Owner is not their starter, and wrong visibility from before #2440.                 | `junior_conversations`, `junior_destinations`                         | 7 (repair); visibility: #2382 | Traced    |
| 20  | Child rows store their own Owner copy, and spend reads it. Child spend can miss the root Owner.           | `chat/conversations/sql/store.ts`, `api/people/spend.query.ts`        | 3, 6                          | Confirmed |
