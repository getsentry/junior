# Actor Identity End State

## Summary

Every root Conversation has one Owner. Every new user Message has one author
Identity. Junior resolves each Identity one time, at ingress, and stores its
id. Later code reads the stored id. It does not guess the Identity again from
platform strings, the Source, the Location, or id patterns.

This plan is the end state for #2439. `design.md` has the model, the schema,
the readers, and the known gaps. `tasks.md` has the steps.

## Motivation

- The runtime `Actor` is typed (`chat/actor.ts`). Stored state changes it to
  `StoredSlackActor`. Many write and read paths then guess the Identity again.
  Each guess can drift.
- `SqlStore.upsertConversation` derives the Identity from the incoming
  Conversation and writes `coalesce(excluded.actor_identity_id, existing)`.
  So a human who replies can replace the system Identity of an automation
  Conversation (#2431). #2436 fixed one case in app code.
- `junior_conversations.actor_identity_id` does four jobs: the root that the
  dashboard shows, private access, spend, and the personal feed.
- No inbound event Message has an author Identity.

## Scope

- One Owner column on `junior_conversations`, set at insert.
- One system Identity.
- A required author Identity on each new user Message.
- The Identity of web users, Slack bots, and event authors.
- The move of every reader from the old column.

## Non-Goals

- Key user credentials by User. Connections stay keyed per platform. This is a
  separate change.
- Change `SystemActor` names or the `Actor` schema. `actorSchema` stays a union
  of `.strict()` objects.
- Name the human who uses the local CLI. The CLI keeps one shared user id.
- Change how Guardian labels authors, or which credentials a Turn uses.
  #2181 and #2260 own those. This plan only widens which event authors
  #2260 trusts.
- Change visibility. #2382 owns it.

## Decisions

### From David Cramer

These are David Cramer's answers in the Slack thread for #2439.

- The Owner is the person who started the Conversation, or the system for an
  automation. Owners never transfer.
- There should be no unknown actors on any Message from now on.
- The local CLI user can be the system Identity.
- A web user is the User they sign in with, through the normal User and
  Identity tables.
- The schema should be normalized.
- Assistant output is just an event. It needs no author Identity.
- Web users always have an Identity. The mock viewer mocks one.
- Child spend rolls up to the root Owner.
- Slack bots have an Identity but no User. A bot is still an Actor.
- For an inbound event, Junior finds the correct Identity. It verifies that
  Identity the same way as everywhere else. The author can be a bot, a person
  whose GitHub account is also a Slack user (such as `dcramer`), or someone
  without Sentry access. Junior ignores the instructions of someone without
  access.
- Most events are system events, with the system Identity as the author.
  Sentry events mostly are. Some GitHub events are too. PR feedback and
  comments are not. The person or bot who wrote them is the author.
- Legacy `junior/<email>` rows: leave them as they are, unless a migration
  path is clearly correct.
- Who shows in the participant list: "same as today: users."
- Do verified event authors become participants: "not right now maybe we will
  change our mind later."
- A verified event author who is not the requester can give instructions if
  they pass the `allowedDomains` check and Junior knows their GitHub Identity.
- "also we'd allow list usernames in juniors config for github events (so we
  could allow list some bots)"
- Name the list "trusted authors": "call it trusted authors or sometihng"
- On the name: "yes "trusted" is what we want here, but you can use the
  suffix that makes sense"

His answers to the 14 earlier proposals:

| #   | Topic                                                       | His words                                                            |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `bot` Identity kind                                         | "bots need to be annotated as bots, thats important"                 |
| 2   | Mock Identity for the local auth bypass                     | "you can find what makes sense"                                      |
| 3   | `isBot` and `trusted` on `doneBy`; no `doneBy` means system | "yes"                                                                |
| 4   | Event author upserts never change `kind` or `user_id`       | "correct"                                                            |
| 5   | An event changes only the Message author                    | "yes but an event _is_ a message so"                                 |
| 6   | `trustedAuthors` logins compared without case               | "yes"                                                                |
| 7   | Owner repair on old rows                                    | "sure defer to you but needs to be correct"                          |
| 8   | Locations group by User                                     | "yep"                                                                |
| 9   | `kind` and `provider` in the dashboard author shape         | "yep. and users have many identities associated to them"             |
| 10  | System Identity key                                         | "thats meaningless to me, make sure its good arch and ill trust you" |
| 11  | Slack bot subject is the bot user id                        | "yep"                                                                |
| 12  | Mock viewer key                                             | "idk up to you make it correct"                                      |
| 13  | "creator" for the Automation's "owner" in `TERMINOLOGY.md`  | "sure, we dont really have "owners" on automations anyways"          |
| 14  | #2260's instruction record keeps the author Identity id     | "ok"                                                                 |

### Delegated Decisions

David handed these four to the plan. His words are in the table above. Each
one is a plan decision. Each gives the choice and one line on why it is
correct.

- **Local auth bypass (2).** The bypass viewer (`dev@example.com`, used when
  `authRequired` is `false`) gets the same key as the mock viewer: kind
  `user`, provider `mock`, tenant `""`, subject the viewer email. With real
  data, the bypass branch of `requireAuth` writes this row and links it to
  the bypass User. No other path writes provider `mock`. Step 3 also moves the
  Vercel guard of `apps/example/dashboard.ts` into the dashboard package, so
  `authRequired: false` fails to start on a Vercel production deploy.
  _Why:_ the bypass has no Google sign-in, so it needs a real row for the
  author check, and a reserved provider that only the bypass writes cannot
  reach a production User.
- **Owner repair (7).** Step 4b repairs a root only when all conditions in
  `design.md`, Owner Repair, are true, and only when the dry-run agreement
  check finds zero disagreements. Every other row keeps its current Identity.
  _Why:_ a `slack` or `web` root starts from a human Message, so its first
  user Message author is its starter. The agreement check proves this on the
  rows that #2436 did not damage before the repair runs on any damaged row.
- **System Identity key (10).** Kind `system`, provider `junior`, tenant
  `""`, subject `system`. Step 3 adds `junior` and `mock` to the providers
  that only core may write (`isNativeIdentityProvider`).
  _Why:_ `junior_identities` is unique on provider, tenant, and subject.
  Plugin registration already reserves the name `junior`. The only other
  `junior` rows use an email or a name from `SystemActor` as the subject, and
  step 3 merges all of these.
- **Mock viewer key (12).** Kind `user`, provider `mock`, tenant `""`,
  subject the viewer email. In mock reporting mode, the Identity is in
  memory only, in `viewer.identities`, with id `mock-identity:<email>`. Junior
  writes no row for it.
  _Why:_ mock reporting writes no durable rows today
  (`mockViewerFromSession`), so the mock Identity cannot collide with a real
  row and does not exist in production.

### Plan Decisions

These are the #2439 end state. They follow from the answers above.

- Slack, web, and fork Conversations have a human Owner. Scheduled
  automations, event automations, plugin dispatch, and the local CLI have the
  system Identity as Owner. David was not sure about plugin dispatch. The code
  runs each dispatch in its own Conversation (`agent-dispatch/README.md`), so
  it is system work.
- Junior sets the Owner one time, at insert. A reply never changes it.
- A child Conversation stores no Owner. It reads the Owner of its root.
- Junior has one system Identity. David asked if Junior needs more than one.
  The code needs only one, because "which system" is provenance
  (`design.md`, System Identity). `SystemActor.name` stays as provenance.
- A web Actor uses the `google` Identity that dashboard sign-in saves. The
  synthetic `junior/<email>` Identity goes away for new writes.
- **A User has many Identities.** One person can have a `slack`, a `google`,
  and a `github` Identity, each linked to the same User. Spend, People, and
  participants roll up by User, not by Identity. The dashboard author shape
  carries the Identity `kind` and `provider`, and the `userId` when the
  Identity links a User (answer 9).
- **Bots are kind `bot`.** A Slack bot or an event bot gets kind `bot` and no
  User (answer 1). Kind `user` is for a person. Kind `service` stays Junior's
  own Service account.
- **Slack bot subject.** The bot user id (`U…`), the same id as
  `slack.allowedBotUserIds`. Use the `bot_id` (`B…`) only when Slack sends no
  bot user id (answer 11).
- The Identity id goes next to the Actor, not inside it.
- Every new user Message row has an author Identity. A check constraint
  enforces this.
- `owner_identity_id` replaces `actor_identity_id`. Junior drops
  `actor_identity_id`, `creator_identity_id`,
  `credential_subject_identity_id`, and `actor_json` from
  `junior_conversations`. This follows the normalized-schema answer. The
  code shows that the two dropped Identity columns are always `null` and have
  no reader.
- **Legacy `junior/<email>` rows.** One migration path is clearly correct: a
  `junior/<email>` row and a `google` row that link the same `user_id`
  belong to the same User. Step 3 moves references from the first to the
  second only in that case. Every other `junior/<email>` row and reference
  stays as it is. Junior stops writing new `junior/<email>` rows.
- **Participants are users.** Participant rows stay as today: only Identities
  of kind `user` with a User (`recordConversationParticipant` in
  `chat/conversations/sql/participants.ts`). The participant list that the
  dashboard shows uses the same rule. Today that list has no `kind` filter,
  so system Identities show (`design.md`, gap 7).
- **An event is a user Message.** An inbound event writes a Message with
  role `user`. Its author is the author Identity of the event: the system
  Identity for a system event, or the person or bot who wrote the content
  (answer 5). The event never changes the Owner or the Turn Actor. The Event
  Turn keeps `EVENT_SYSTEM_ACTOR`.
- **Event Message authors are not participants.** Today
  `chat/conversations/sql/history.ts` records a participant for each Message
  author with an Identity. Step 3 skips this for event Messages. A verified
  GitHub commenter gets no access to a private Conversation. This can change
  later.
- **Event author fields.** `doneBy` gets `isBot` and `trustedAuthor`, next
  to `subjectId` from #2260. The plugin sets them. David agreed to a
  `trusted` flag (answer 3). The plan names it `trustedAuthor`, because the
  event schema already has `trustedSummary` beside `doneBy`, and that field
  means plugin facts that are never instructions. An event with no `doneBy` or
  no `subjectId` uses the system Identity, and its text stays data
  (answer 3).
- **Event author Identity.** Core upserts the author Identity with the OAuth
  link key and no email. The upsert never changes the `kind` or `user_id` of
  an existing row (answer 4).
- **Event author trust.** The text of an event author counts as
  instructions when one of these is true:
  - `findLinkedSlackMember()` returns `linked` for the author's account. This
    is the check that #2260 and #2217 use for the same question. It needs the
    exact linked account id, one linked Slack user, a current human member,
    and a Slack email on `allowedDomains` (`design.md`, Event Authors).
  - the author's GitHub login is on the GitHub plugin trusted authors list.
    The plugin compares logins without case (answer 6).

  All other event text is data only. This includes a bot that is not on the
  list, a person with no linked account, and a deactivated member. #2260 lets
  only the Watch requester's text count. This rule is wider.

- **Trusted text stays narrow.** Only `doneByText` counts, with quoted lines
  removed. Core renders it in #2260's `Requester instruction` section. It is
  never a `user:` line and never an approval. #2260's
  `requesterInstructionSchema` keeps the author Identity id, because a
  trusted bot has no Slack Actor (answer 14).
- **Guardian labels come from the Actor and provenance.** They never come
  from the Identity id alone. With one system Identity, an Identity id
  compare would make every system author match the Turn Actor
  (`design.md`, Guardian Labels).
- **Trusted author name.** David chose the word "trusted". The plan chose
  the suffix "Authors", because the list holds event author logins. The
  option is `githubPlugin({ trustedAuthors })`. `TERMINOLOGY.md` defines
  Trusted author. It is different from the "trusted" summary and details in
  `chat/README.md`, which are plugin facts and never instructions.
- **The trusted authors list lives in the GitHub plugin.** The option is
  `githubPlugin({ trustedAuthors: [...] })`. It takes GitHub logins, such as
  `some-app[bot]`. No such list exists today. `GitHubPluginOptions`
  (`junior-github/src/plugin.ts`) has no author list.
  `slack.allowedBotUserIds` (`app.ts`, `chat/ingress/slack-allowed-domain.ts`)
  covers only Slack ingress. The new list follows the same pattern, but in
  the plugin config. The plugin compares the event login to the list and
  gives core one provider-neutral result: this author is trusted. Core does
  not read GitHub logins (`policies/provider-boundaries.md`).
- **Locations group by User** (answer 8), with the Identity as fallback for
  an Identity with no User.
- **Automation creator.** `TERMINOLOGY.md` now says that an Automation has a
  creator, not an owner (answer 13). "Owner" means only the Owner of a
  Conversation.
- **Identity keys.** An event author uses the key that the OAuth link writes:
  provider `github`, tenant `""`, subject `String(sender.id)`. A web Actor
  finds its `google` row through its User, because `WebActor` has no OIDC
  `sub`. `design.md`, Identity Keys, has every key.
- **Mailbox field.** The mailbox entry carries `input.authorIdentityId` next
  to `input.authorId`. `inboundMessageSchema` has no `actor` field.
- **Rollout.** The Owner check ships one release after the Owner writer
  (steps 4a and 4b). Each column drop takes two releases (steps 6 and 7). The
  system merge covers every row of kind `system`.

### Code Facts

- Old dashboard sessions need no invalidation. David asked about this. The
  code shows that each live session already has a `google` Identity
  (`design.md`, Web Users).
- Today the Identity upsert changes `kind` on conflict
  (`kind: excluded.kind` in `upsertIdentityRecord`, `chat/identities/sql.ts`).
  It keeps an existing `user_id`. So answer 4 needs a code change in step 3:
  an event upsert keeps the existing `kind`.
- `junior_identities` is unique on provider, tenant, and subject
  (`junior_identities_provider_subject_uidx`). `kind` is not part of the key.
  So one account cannot have both a `bot` row and a `user` row.
- People already groups by User (`primaryEmailNormalized` in
  `api/people/list.query.ts` and `profile.query.ts`). It counts a root only
  when its Identity has a verified email (`verifiedActorWhere`). The
  participant list already groups by User, with the Identity as fallback
  (`api/conversations/participants.ts`). Only Locations groups by Identity.

## Open Proposals

These still wait for David.

- **Bot logins only on the trusted authors list.** Recommendation: yes. The
  plugin accepts a login only when it ends in `[bot]` and the webhook
  `sender.type` is `Bot`. It ignores a human login on the list and logs it.
  _Risk if no:_ GitHub can give a renamed or deleted user's login to a new
  account. That new person then passes as a trusted author. GitHub Apps keep
  the `[bot]` suffix, and a user account cannot take it. Numeric account ids
  are the other option. They never move to a new account, but they are hard
  to read in config.

## Behavior Changes

- Automation-run spend leaves personal spend. A system Owner has no User.
- A human who replies to an automation Conversation gets access as a
  participant, not as Owner.
- Child spend rolls up to the root Owner. Today `peopleTreeMetricsJoin`
  (`api/people/shared.ts`) gives a child's metrics to the child's own Identity
  when it differs from the root.
- A web user's Messages and Conversations use their `google` Identity. People
  still groups them with the same User.
- Text from a trusted event author counts as instructions. With #2260, only
  the Watch requester's text does.
- The dashboard participant list stops showing system Identities.

## Risks

- The Owner backfill changes access, the feed, People, and spend. Step 4b runs
  a dry-run count first. It adds a participant row for each human who was the
  root Identity and is not the Owner.
- Old workers keep running during a deploy. They can reject new fields in
  `.strict()` schemas, insert rows without new values, and select every
  schema column. `tasks.md`, Release Rules, gives the order for fields,
  checks, and column drops.
- A human GitHub login can move to a new account after a rename. Until David
  answers the open proposal, the trusted authors docs warn about this.
- A write with no author Identity fails after step 5. A missed ingress path
  shows up as an error, not as wrong data. The legacy fallback logs first, so
  the logs find missed paths before the constraint ships.
