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
- Change Guardian authority. #2181 and #2260 own it.
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
- **Event authors are not participants.** Today
  `chat/conversations/sql/history.ts` records a participant for each Message
  author with an Identity. Step 3 skips this for event Messages. A verified
  GitHub commenter gets no access to a private Conversation. This can change
  later.
- **Event author trust.** The text of an event author counts as
  instructions when one of these is true:
  - the author's `github` Identity links to a User, and the domain of that
    User's primary email passes `allowedDomains`;
  - the author's GitHub login is on the GitHub plugin allow list.

  All other event text is data only. This includes a bot that is not on the
  list and a person with no linked User. #2260 lets only the Watch requester's
  text count. This rule is wider.

- **The allow list lives in the GitHub plugin.** No such list exists today.
  `GitHubPluginOptions` (`junior-github/src/plugin.ts`) has no author list.
  `slack.allowedBotUserIds` (`app.ts`, `chat/ingress/slack-allowed-domain.ts`)
  covers only Slack ingress. The new list follows the same pattern, but in
  the plugin config. The plugin compares the event login to the list and
  gives core one provider-neutral result: this author is trusted. Core does
  not read GitHub logins (`policies/provider-boundaries.md`). The domain
  check reuses `allowedDomains` as it is (`chat/sign-in/allowlist.ts`). An
  empty `allowedDomains` allows every domain, the same as for Slack.

### Code Facts

- Old dashboard sessions need no invalidation. David asked about this. The
  code shows that each live session already has a `google` Identity
  (`design.md`, Web Users).

## Proposals

These are not agreed yet.

1. **`bot` Identity kind.** A Slack bot or event bot gets kind `bot`. Kind
   `user` would link a User through a verified email. Kind `service` means
   Junior's own Service account.
2. **Local auth bypass.** The bypass viewer (`dev@example.com`) gets a mock
   Identity, the same as the mock viewer.
3. **Event actor declaration.** Each plugin sets `hasActor: true` on the event
   types whose payload has text that a person or bot wrote. Examples are PR
   and issue bodies on `opened`, comments, reviews, and review comments. Other
   types use the system Identity.
4. **Event author field.** `doneBy` gets `subjectId` (from #2260), `isBot`,
   and `trusted`. The plugin sets all three. `trusted` is `true` only when the
   plugin allow list has the author. When the type has `hasActor`, core
   rejects an event with no `subjectId`.
5. **Event author Identity.** Core upserts the Identity from `doneBy` with no
   email. So the event never links a User. The Identity is verified only when
   it already links to a User through OAuth or a verified email.
6. **Event Owner and Turn Actor.** An event changes only the Message author.
   The Owner stays. The Event Turn keeps `EVENT_SYSTEM_ACTOR`.
7. **Allow list option.** `githubPlugin({ allowedEventAuthors: [...] })` takes
   GitHub logins, such as `some-app[bot]`. The plugin compares logins without
   case.
8. **Owner repair.** The Owner backfill can repair a root with a `slack` or
   `web` Source and a system Identity. These rows got the system Identity
   before #2436. The repair is clearly correct only when the first user
   Message of the root has an author Identity of kind `user` with a User. The
   backfill then uses that Identity. Otherwise it copies the current Identity
   and leaves the row as it is.
9. **Locations group by User.** The location actor list groups by User, with
   the Identity as fallback.
10. **Dashboard author shape.** The dashboard `actorIdentitySchema` gets the
    Identity `kind` and `provider`.

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

- The Owner backfill changes access, the feed, People, and spend. Step 4 runs
  a dry-run count first. It adds a participant row for each human who was the
  root Identity and is not the Owner.
- Old workers keep running during a deploy. They can reject new fields in
  `.strict()` schemas and can write old columns. Each step ships readers
  before writers and drops a column one release after its last writer.
- A human GitHub login can change owners after a rename. A GitHub App login
  ends in `[bot]`, and GitHub keeps that suffix for Apps. The allow list docs
  should say to list bot logins.
- A write with no author Identity fails after step 5. A missed ingress path
  shows up as an error, not as wrong data. The legacy fallback logs first, so
  the logs find missed paths before the constraint ships.
