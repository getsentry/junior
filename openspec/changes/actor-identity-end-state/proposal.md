# Actor Identity End State

## Summary

Every root Conversation has one Owner. Every new user Message has one author
Identity. Junior resolves each Identity one time, at ingress, and stores its
id. Later code reads the stored id. It does not guess the Identity again from
platform strings, the Source, the Location, or id patterns.

The Owner is the existing `junior_conversations.actor_identity_id` column.
Code and docs call it the Owner.

Junior migrates an old data shape only when special code exists because of
it, and only with a rule that a read-only dry run proves. Then Junior deletes
that code.

This plan is the end state for #2439. It fixes the target and the rules.
Each step decides its own implementation details when it is built
(`tasks.md`, How To Use This Plan). `design.md` has the model and the known
gaps.

## Motivation

- The runtime `Actor` is typed. Stored state changes it to a Slack-only
  shape. Many write and read paths then guess the Identity again. Each guess
  can drift.
- On `main`, the Conversation write keeps the newest non-empty Identity. So
  a human who replies can replace the system Identity of an automation
  Conversation (#2431). #2436 fixed one case in app code. #2482 makes the
  write keep the first value.
- The Conversation Identity column does four jobs: the root that the
  dashboard shows, private access, spend, and the personal feed. Each job
  must read the root Owner. Today a child row has its own copy, so child
  spend can go to the child's own Identity.
- No inbound event Message has an author Identity.
- Old rows have data shapes that only special code can read. That code stays
  until the data migrates.

## Scope

- One Owner per root Conversation, in the existing Conversation Identity
  column. Junior sets it one time.
- One system Identity.
- A required author Identity on each new user Message.
- The Identity of web users, bots, and event authors.
- Every reader of the Owner uses the root Owner.
- One data migration for the old data shapes that have special code.
- A separate repair of old Owner damage (#2431), only for rules that a dry
  run proves.

## Non-Goals

- Add a new Owner column, or rename the existing column.
- Key user credentials by User. Connections stay keyed per platform. This is a
  separate change.
- Change `SystemActor` names or the `Actor` schema.
- Name the human who uses the local CLI. The CLI keeps one shared user id.
- Change how Guardian labels authors, or which credentials a Turn uses.
  #2181 and #2260 own those. This plan only widens which event authors
  #2260 trusts.
- Change visibility. #2382 owns it.
- Migrate legacy `junior/<email>` web Identities.
- Migrate Redis or Turn checkpoint data. Junior waits for it to expire.

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
- Slack bots: "they have an identity, but not a user (does that make
  sense?) its still an actor"
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
- On trust: "any sender who doesnt have the allowed domain email address or
  is unknown isnt trusted. bots and or other users could be listed under
  trusted"
- On what trusted text may do: "trusted authors are the same as normal
  authors... its just that untrusted authors we dont run"
- On the proposal that the event author is never the Turn Actor: "I agree,
  lets not have it be the turn actor as it expands the security concerns. you
  need to document that (confused deputy concerns for example). knowing who it
  is that maps to our internal users is valuable tho so keep that"
- On the proposals to split batches by trust and to save untrusted entries as
  hidden Messages: "untrusted events wont actually ever be seen so i think
  (2/3) is not relevant? system events might have untrusted text but we
  already handle that"
- On Cursor Bugbot: "yeah Bugbot and sentry will end up on trusted actors"

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

His answers to the three questions on old data and the Owner column. The
topic column gives the plan's proposal. The quote is his exact reply.

| #   | Topic                                                             | His words                                                                                                              |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Old event Messages get the system Identity as their author        | "(1) yes"                                                                                                              |
| 2   | Old user Messages whose author cannot be proven                   | "(2), why not just make them system? if they dont have an author just make them without an author? should be uncommon" |
| 3   | Keep `junior_conversations.actor_identity_id` as the Owner column | "(3) i guess? usually theres just like one actor.. everything else is metadata"                                        |

### Delegated Decisions

David handed these four to the plan. His words are in the first table above.
Each one is a current proposal. The step that builds it confirms it.

- **Local auth bypass (2).** The bypass viewer gets an Identity that only the
  bypass writes, so it can never match a production User. The dashboard
  refuses the bypass on a production deploy. _Why:_ the bypass has no Google
  sign-in, but its Messages still need an author. Confirm in step 4.
- **Owner repair (7).** Junior repairs an old root only when a dry run proves
  the rule. Every other row keeps its current Owner. `design.md`, Owner
  Repair, gives the rules. Confirm in step 7.
- **System Identity key (10).** One system Identity, with a key that no
  plugin or OAuth link can write. #2443 (step 1) built the one entry point.
  #2482 (step 2) gives the system Identity the fixed id `system`.
- **Mock viewer key (12).** The mock viewer gets an Identity in memory only.
  Mock reporting writes no rows today, so it cannot collide with a real row.
  Confirm in step 4.

### Plan Decisions

These follow from the answers above. They are the target. Where a bullet says
"plan reading", it is how the plan reads David's words.

- **Owners.** Slack, web, and fork Conversations have a human Owner.
  Scheduled automations, event automations, plugin dispatch, and the local
  CLI have the system Identity as Owner. Plugin dispatch runs each dispatch in
  its own Conversation, so it is system work.
- Junior sets the Owner one time, at insert. A reply never changes it.
- A child Conversation stores no Owner. It reads the Owner of its root.
- **The Owner column.** The existing `junior_conversations.actor_identity_id`
  column is the Owner (answer 3 on old data). Code and docs call it the
  Owner. There is no new Owner column and no rename. #2482 makes the
  Conversation write keep the first value, which is the Owner rule.
- **One system Identity.** "Which system" is provenance: the Source and the
  Automation or dispatch record (#2211). `SystemActor.name` stays as runtime
  provenance.
- **Web users.** A web Actor uses the Identity that dashboard sign-in saves.
  Junior stops writing the synthetic `junior/<email>` Identity.
- **A User has many Identities.** Spend, People, participants, and Locations
  roll up by User. The dashboard author shape shows the Identity kind and
  provider, and the User when there is one (answer 9).
- **Bots.** A bot has its own Identity of kind `bot` and no User (answer 1).
  A Slack bot uses its bot user id (answer 11).
- **Identity id next to the Actor.** The Identity id travels next to the
  Actor, never inside it. Old workers and external plugins must still parse
  the `Actor`.
- **No unknown authors.** Every new user Message has an author Identity.
  Assistant output has none.
- **Normalized schema.** The Owner is the existing Conversation Identity
  column. The two unused Conversation Identity columns
  (`creator_identity_id`, `credential_subject_identity_id`) and the stored
  Actor JSON (`actor_json`) go away.
- **Legacy data rule.** Junior migrates an old data shape only when special
  code exists because of it, and only with a rule that a read-only dry run
  proves. Then Junior deletes that code. `design.md`, Legacy Data, lists the
  shapes.
- **Old event Messages.** An old event Message gets the system Identity as
  its author (answer 1 on old data). Those Turns ran as system, and Junior
  never saved the real writer of a PR comment.
- **Old user Messages with no provable author.** Plan reading of answer 2 on
  old data: these Messages stay with no author. Junior does not guess one.
  The dry run counts them to confirm that they are uncommon. _Why not the
  system Identity:_ a human Message stored as system could later read as a
  system or automation Message in history.
- **Legacy `junior/<email>` rows.** No migration is needed. They are valid
  Identities, and they link to the right User. Readers group by User, so
  these rows show correctly. A merge into the sign-in Identity is optional.
- **Redis and Turn checkpoint data.** No migration is needed. Junior waits
  for the data to expire. Redis work state expires after 7 days. The plan
  waits 14 days.
- **Owner repair is separate from the migration.** It fixes wrong data, not
  a code path. It runs only for the rules that the dry run proves
  (`design.md`, Owner Repair).
- **Participants are users.** Only Identities of kind `user` with a User get
  participant rows. The dashboard participant list uses the same rule.
- **An event is a user Message.** Its author is the Identity of the person or
  bot who wrote the content, or the system Identity for a system event
  (answer 5). An event never changes the Owner or the Turn Actor.
- **The event author is never the Turn Actor.** David agreed. Event Turns
  stay system-acted, as on `main` today. A Turn's credentials come only from
  the Watch or the Automation's own grant, never from the event author.
  `design.md`, Why The Event Author Is Not The Turn Actor, gives the reason.
- **Junior still resolves the event author.** David asked to keep this. The
  author resolves to its Identity and, when there is one, its linked User. The
  author labels the Message and feeds the trust check. It does nothing else.
- **Event authors are not participants.** A verified GitHub commenter gets no
  access to a private Conversation. This can change later.
- **Event author Identity.** It is the same row that the OAuth link writes
  for that account. An event write never changes the `kind` or the User of an
  existing row (answer 4). An event can name an author only on its own
  provider, never on a core provider.
- **Event author facts.** The plugin tells core the author account, whether
  it is a bot, and whether it is on the trusted authors list (answer 3).
- **Trust rule.** An event author is trusted when Junior verifies their
  linked Identity on an allowed domain, the same check that #2260 and #2217
  use, or when their login is on `trustedAuthors`. Logins compare without
  case (answer 6). An unknown sender is never trusted. All other authors are
  untrusted.
- **Trusted text is a chat message.** Plan reading: Junior treats text from a
  trusted author exactly like a chat message from that author. The same rules
  apply as for any chat author, no more and no less.
- **Untrusted authors are never seen.** An event from an untrusted or
  unknown author does not start a run. Plan reading of David's words: Junior
  drops it before it joins a batch or a Turn, so the agent never sees it.
  Only trusted and system entries are batched.
- **System events run as today.** A system event can carry untrusted external
  text. The current event handling already covers this (`design.md`, Trust).
  This plan adds no rule for it.
- **The list can name bots and people.** Plan reading: the list is an
  explicit exception to the domain rule. A listed login needs no linked
  account and no allowed-domain email.
- **Bugbot and Sentry are trusted authors.** Plan reading: David wrote
  "trusted actors", and the plan reads this as the GitHub plugin
  `trustedAuthors` list. Cursor Bugbot and Sentry's GitHub bot go on that
  list in the deployed app config. Step 4 confirms the exact logins from real
  event senders. That config ships with the trust rule, or their PR feedback
  stops starting runs.
- **Only the author's own text counts.** Lines that the author only quotes
  are not the author's text (#2260 removes them today).
- **A bot is an Actor in David's sense.** Plan reading: the bot has its own
  Identity and is the author of its Messages. This needs no `Actor` schema
  change.
- **Guardian labels come from the Actor and provenance.** They never come
  from the Identity id alone. With one system Identity, an id compare would
  make every system author match the Turn Actor.
- **The trusted authors list lives in the GitHub plugin config**, as
  `trustedAuthors`. Core gets only a provider-neutral "trusted" result. Core
  does not read GitHub logins (`policies/provider-boundaries.md`).
- **Locations group by User** (answer 8).
- **Automation creator.** An Automation has a creator, not an owner
  (answer 13). "Owner" means only the Owner of a Conversation.

## Open Questions

None.

Resolved:

- **Mixed event batch.** Drop untrusted entries, or keep them as context?
  David: "untrusted events wont actually ever be seen so i think (2/3) is not
  relevant?" Junior drops them before batching (Plan Decisions). The plan
  adds no separate path to deliver or hide them.
- **Cursor Bugbot on `trustedAuthors`.** David: "yeah Bugbot and sentry will
  end up on trusted actors" (Plan Decisions).
- **Old data and the Owner column.** David answered the three questions in
  the second table above (Plan Decisions).

## Behavior Changes

- Automation-run spend leaves personal spend. A system Owner has no User.
- A human who replies to an automation Conversation gets access as a
  participant, not as Owner.
- Child spend rolls up to the root Owner. Today it can go to the child's own
  Identity.
- A web user's new Messages and Conversations use their sign-in Identity.
  People still groups them with the same User as the old `junior/<email>`
  rows.
- Text from a trusted author counts the same as a chat message from that
  author. Events from an untrusted or unknown author do not run, and the
  agent never sees them. Today an untrusted author's event runs, with its
  text as data.
- The dashboard participant list stops showing system Identities.
- Locations show one row per User.
- Old event Messages show the system Identity as their author.
- Old user Messages with no provable author show no author.

## Risks

- The Owner repair changes access, the feed, People, and spend. It runs only
  for the rules that the dry run proves, and only after David's OK. Humans
  who lose the root keep access as participants.
- Until #2482 runs on every worker, a human Turn can still replace the Owner
  of a system root. So damage can keep happening until then. The repair runs
  after that point.
- Old workers keep running during a deploy. They can reject new fields,
  write rows without new values, and select old columns. `tasks.md`, Release
  Rules, gives the rules.
- GitHub can give the login of a renamed or deleted account to a new
  account. That new account then passes as a trusted author. The trusted
  authors docs must say to list stable logins and to review the list.
- An untrusted author's event stops starting a run. A review bot that is not
  on the trusted authors list no longer starts PR maintenance work. Bugbot
  and Sentry's bot go on the list with the trust rule (Plan Decisions).
- After step 8, a write with no author Identity fails. A missed ingress path
  shows up as an error, not as wrong data. The step 2 fallback logs show
  missed paths before enforcement ships.
