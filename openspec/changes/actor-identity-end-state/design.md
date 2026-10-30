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
- Junior sets the Owner at insert. No later write changes it.
- An Automation has a creator (`TERMINOLOGY.md`). The creator is not the
  Owner of the Conversations that its runs create.

### Owner Repair

Before #2436, the Conversation write could replace the human Identity of a
`slack` or `web` root with a system Identity. The same write could also
replace one human Identity with a later human Identity. So today's Identity
of a root is not always its starter.

Rules:

- Leave old rows as they are, unless the repair is clearly correct.
- Run a dry run first, and post its counts on #2439.
- Do not run a production backfill without explicit approval.
- When the dry run shows that the rule disagrees with rows that were not
  damaged, drop the repair. Then every row keeps its current Identity.

Current proposal, to confirm in step 4b:

- Repair only a root that is not a fork, has a `slack` or `web` Source, and
  has a system Identity today.
- The repaired Owner is the author of the first human user Message. That
  author must be a person with a User that fits the Source.
- Repair only roots with one author User across their human user Messages.
  Junior cannot pick the starter of a root with more than one human author.
- Event Messages and bot Messages do not count as human user Messages. They
  have no author Identity today. An event Turn is how many damaged roots got
  their system Identity, so these roots have event Messages.
- Agreement check: on roots that have a `user` Identity today and one author
  User, count the rows where that author is a different User. One
  disagreement drops the repair.

### Child Conversations

- A child stores no Owner. It reads its root Owner.
- Access already reads the root Identity, not the child's own. #2382 uses the
  same rule for visibility.
- Child spend goes to the root Owner.
- `onBehalfOf` (#2181) is Message provenance. It gives no access, spend, or
  feed rights.

### System Identity

- Junior has one system Identity. Every `SystemActor` and every `LocalActor`
  maps to it. No plugin and no OAuth link can write its key.
- "Which system" is provenance. It comes from the Conversation Source and the
  Automation or dispatch record (#2211). `SystemActor.name` stays in runtime
  code.
- #2443 (step 1) adds the one entry point from an Actor to an Identity, and
  maps system and local Actors to the one system Identity.
- Today a Conversation with no Actor still writes a legacy per-name system
  row (`scheduler`, `local-cli`, or `event`). The names of these rows are the
  root labels that the dashboard shows today ("Scheduler", "Local CLI",
  "Event").
- Rule: before Junior merges the legacy rows into the one system Identity,
  the readers must take the system label from the Source or the Automation
  or dispatch record. No visible label may change to "System".

### Users And Identities

- A User is one person. A User has many Identities, for example a `slack`
  Identity, a dashboard sign-in Identity, and a `github` Identity from an
  OAuth link.
- Spend, People, participants, and Locations roll up by User. The Identity
  is the fallback only for an Identity with no User, such as a bot.
- A Message author and an Owner are Identities. A reader joins the Identity
  to its User to group.

### Web Users

- A web Actor uses the Identity that dashboard sign-in saves for the viewer
  User. Today that is the `google` Identity. Junior stops writing the
  synthetic `junior/<email>` Identity.
- Old sessions need no invalidation. When this plan was written, sessions
  lasted at most 8 hours, and each sign-in since #2220 saves the `google`
  Identity. Re-check this in step 3.
- The mock viewer gets a mock Identity. Mock reporting writes no rows, so
  this Identity is in memory only.
- The local auth bypass: current proposal, to confirm in step 3. The bypass
  User gets a mock Identity that only the bypass writes. The dashboard
  refuses the bypass on a production deploy. Today only the example app
  refuses it.

### Bots

- A bot has an Identity of kind `bot` and no User.
- A Slack bot uses its bot user id (answer 11). The fallback when Slack sends
  no bot user id is decided in step 3.
- With no User, a bot never counts as a person in spend, People, or
  participants.

### Event Authors

- An event is a Message with role `user`. Its author is the Identity of the
  person or bot who wrote the content. An event with no author uses the
  system Identity. It is a system event, and it runs as today.
- An event never changes the Owner or the Turn Actor.
- The author Identity is the same row that the OAuth link writes for that
  account. An event write never changes the `kind` or the User of an existing
  row. Today the Identity write changes `kind` on conflict, so step 3 must
  change this.
- An event can name an author only on its own provider. A core provider gets
  the system Identity. So a plugin cannot write an Identity for another
  provider.
- An event author never becomes a participant.
- Event automations write no event Message. They start an Automation run.

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
- Event batches: one Turn can take many events as one Message. Junior decides
  trust for each event, before the Turn starts. An untrusted entry never
  starts a Turn and never counts as instructions. When no trusted or system
  entry is left, no Turn starts. Whether untrusted entries are dropped or kept
  as context is open (`proposal.md`, Open Questions, 1). The current proposal
  for the batch Message author is: the shared author when every entry has the
  same one, else the system Identity. Confirm in step 3.

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
- Junior resolves the author at ingress. A missing author fails the write.
  Fallbacks exist only to read legacy rows, and they log.

### Identity Id Placement

- The Identity id travels next to the Actor, never inside it. The `Actor`
  schema is closed, so a new field would make old workers and external
  plugins reject it.
- The Turn, the mailbox entry, and the Message each carry the author
  Identity id. Step 2 decides the field names.
- The Conversation carries the Owner.

## Storage Rules

- Each root Conversation stores its Owner. A child stores none.
- Enforcement that a new root has an Owner ships only after every writer sets
  it.
- Enforcement that a new user Message has an author ships only after every
  writer sets it. It does not apply to legacy rows.
- The old Conversation Identity column, the two unused Identity columns, and
  the stored Actor JSON go away. Each one goes only after no code uses it
  (`tasks.md`, Release Rules).
- Each step decides its own SQL, constraint text, and index names.

## Known Gaps

Checked against `main` at `c122def15`. Re-check each gap at the start of the
step that closes it. "Confirmed" means the cited code shows the fault.
"Traced" means the fault follows from a path through several files. No gap
was reproduced at runtime. No production data was queried.

No gap is fully fixed on `main`. #2436 fixed part of gap 10. #2437 fixed part
of gap 17. #2440 fixed part of gap 19. #2443 is in review.

| #   | What breaks now                                                                                           | Where                                                                 | Step                           | Evidence  |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------ | --------- |
| 1   | No event Message has an author Identity. Core does not read the GitHub sender id.                         | `chat/events/notification.ts`, `junior-github/src/webhooks/events.ts` | 3                              | Confirmed |
| 2   | Guardian sends every web Actor as local.                                                                  | `guardian/gate.ts`, `guardian/proposal.ts`                            | 5                              | Confirmed |
| 3   | Message authors in root Conversations come from the root Source or Location. A bot author gets no Actor.  | `agent-invocations/root-conversation.ts`                              | 5                              | Confirmed |
| 4   | Session logs drop every Actor that is not Slack.                                                          | `task-execution/turn-cursor.ts`                                       | 2, 5                           | Confirmed |
| 5   | Activity metadata guesses the Source. A web Turn with no saved Source gets `local`.                       | `task-execution/turn-cursor.ts`                                       | 5                              | Traced    |
| 6   | Event Message authors are guessed from id patterns and the Location, and web gets the synthetic Identity. | `chat/conversations/sql/event-actor.ts`                               | 1, 3, 5                        | Confirmed |
| 7   | The participant list shows system Identities.                                                             | `api/conversations/participants.ts`                                   | 3                              | Confirmed |
| 8   | Locations show a person with two Identities two times.                                                    | `api/locations/query.ts`                                              | 4b                             | Confirmed |
| 9   | Connections are keyed per platform. A Slack connection does not show on the web.                          | `api/connections/routes.ts`                                           | Non-Goal                       | Confirmed |
| 10  | A later human Turn can replace the Identity of a system root. #2436 fixed only the Source case.           | `chat/conversations/sql/store.ts`, `sql/actor-identity.ts`            | 2, 4a                          | Traced    |
| 11  | Legacy system Identity names do not match `SystemActor.name` values.                                      | `sql/actor-identity.ts`                                               | 3                              | Confirmed |
| 12  | The local CLI uses one user id for every person and for its tokens.                                       | `chat/local/runner.ts`, `chat/local/credential-sync.ts`               | 3; naming the human: Non-Goal  | Confirmed |
| 13  | The `Actor` schema is closed. A TODO questions the system platform value.                                 | `junior-plugin-api/src/schemas.ts`                                    | Non-Goal                       | Confirmed |
| 14  | The dashboard author shape is Slack only. It cannot show a system, bot, or GitHub author.                 | `api/schema/conversation.ts`                                          | 5                              | Confirmed |
| 15  | Conversations and Redis work state store a Slack-only Actor shape.                                        | `chat/conversations/store.ts`, `task-execution/state.ts`              | 5                              | Confirmed |
| 16  | Two Conversation Identity columns are always empty.                                                       | `chat/conversations/sql/store.ts`                                     | 2, 6, 7                        | Confirmed |
| 17  | Web uses the synthetic `junior/<email>` Identity. The mock viewer and the local bypass have none.         | `sql/actor-identity.ts`, `junior-dashboard/src/app.ts`                | 3                              | Confirmed |
| 18  | No rule checks if an event author is a verified person before Junior follows their text.                  | `agent-invocations/root-conversation.ts`, `guardian/policy.ts`        | 3                              | Traced    |
| 19  | Old rows: web roots with a system Identity from before #2436, and wrong visibility from before #2440.     | `junior_conversations`, `junior_destinations`                         | 4b (repair); visibility: #2382 | Traced    |
