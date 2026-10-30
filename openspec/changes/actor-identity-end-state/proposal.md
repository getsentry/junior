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

- Assistant output is just an event. It needs no author Identity.
- Web users always have an Identity. The mock viewer mocks one. He asked if
  older sessions must be invalidated. The code shows that they need no
  invalidation (`design.md`, Web Users).
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

### Plan Decisions

These are the #2439 end state.

- The Owner is the Identity that started the Conversation. It is the human for
  Slack, web, and fork. It is the system Identity for scheduled automations,
  event automations, plugin dispatch, and the local CLI.
- Junior sets the Owner one time, at insert. A reply never changes it.
- A child Conversation stores no Owner. It reads the Owner of its root.
- Junior has one system Identity. `SystemActor.name` stays as provenance.
- A web Actor uses the `google` Identity that dashboard sign-in saves. The
  synthetic `junior/<email>` Identity goes away.
- The Identity id goes next to the Actor, not inside it.
- Every new user Message row has an author Identity. A check constraint
  enforces this.
- `owner_identity_id` replaces `actor_identity_id`. Junior drops
  `actor_identity_id`, `creator_identity_id`,
  `credential_subject_identity_id`, and `actor_json` from
  `junior_conversations`.

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
4. **Event author field.** `doneBy` gets `subjectId` (from #2260) and
   `isBot`. The plugin sets both. When the type has `hasActor`, core rejects
   an event with no `subjectId`.
5. **Event author Identity.** Core upserts the Identity from `doneBy` with no
   email. So the event never links a User. The Identity is verified only when
   it already links to a User through OAuth or a verified email.
6. **Event Owner and Turn Actor.** An event changes only the Message author.
   The Owner stays. The Event Turn keeps `EVENT_SYSTEM_ACTOR`.
7. **Owner repair.** The Owner backfill gives a root with a human Source and a
   system Identity the author of its first user Message. These are rows that
   got a system Identity before #2436.
8. **Locations group by User.** The location actor list groups by User, with
   the Identity as fallback.
9. **Dashboard author shape.** The dashboard `actorIdentitySchema` gets the
   Identity `kind` and `provider`.

## Open Questions

1. **Legacy `junior/<email>` rows with no `google` row.** A user who used the
   dashboard only before #2220 has only the synthetic row. Recommendation: keep
   these rows for legacy reads, count them in the dry run, and never write
   them again.
2. **Who shows in the participant list?** `readConversationParticipants` has
   no `kind` filter. Recommendation: list only Identities with a linked User.
3. **Do verified event authors become participants?**
   `recordConversationParticipant` adds every linked human author. So a
   verified GitHub commenter would get access to a private Conversation.
   Recommendation: event authors do not become participants.
4. **Can a verified event author give instructions?** #2260 treats event text
   as an instruction only from the linked user who created the Watch.
   Recommendation: text from other verified authors stays information until
   #2260 or a follow-up decides. Text from an author with no User is always
   information.

## Behavior Changes

- Automation-run spend leaves personal spend. A system Owner has no User.
- A human who replies to an automation Conversation gets access as a
  participant, not as Owner.
- Child spend rolls up to the root Owner. Today `peopleTreeMetricsJoin`
  (`api/people/shared.ts`) gives a child's metrics to the child's own Identity
  when it differs from the root.
- A web user's Messages and Conversations use their `google` Identity. People
  still groups them with the same User.

## Risks

- The Owner backfill changes access, the feed, People, and spend. Step 4 runs
  a dry-run count first. It adds a participant row for each human who was the
  root Identity and is not the Owner.
- Old workers keep running during a deploy. They can reject new fields in
  `.strict()` schemas and can write old columns. Each step ships readers
  before writers and drops a column one release after its last writer.
- A write with no author Identity fails after step 5. A missed ingress path
  shows up as an error, not as wrong data. The legacy fallback logs first, so
  the logs find missed paths before the constraint ships.
