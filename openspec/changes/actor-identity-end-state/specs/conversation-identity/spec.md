# Conversation Identity

These requirements give the end state. Each step in `tasks.md` decides how to
build them.

## ADDED Requirements

### Requirement: One Root Actor Per Conversation

Each root Conversation SHALL have one root Actor. The root Actor SHALL be the
Identity that started the Conversation. Junior SHALL set it one time, at create.
Junior SHALL NOT change it later.

The root Actor SHALL be the existing `junior_conversations.actor_identity_id`
column. Code and docs SHALL call it the root Actor. Junior SHALL NOT add another
root Actor column.

The root Actor SHALL NOT grant access, feed membership, or defaults. A
Conversation has no owner. Junior SHALL use Participants for those.

#### Scenario: Human starts a Conversation

- **WHEN** a human starts a Conversation from Slack, the dashboard, or a fork
- **THEN** the root Actor is that human's Identity.

#### Scenario: System starts a Conversation

- **WHEN** a scheduled automation, an event automation, a plugin dispatch, or
  the local CLI starts a Conversation
- **THEN** the root Actor is the one system Identity
- **AND** the Conversation Source and the Automation or dispatch record tell
  which system started it.

#### Scenario: Human replies to a system Conversation

- **WHEN** a human replies in a Conversation that the system Identity owns
- **THEN** the root Actor stays the system Identity
- **AND** the human becomes a participant
- **AND** the human gets access and feed membership as a participant.

### Requirement: Child Conversations Use The Root Actor

A child Conversation SHALL NOT store a root Actor. Junior SHALL read the root
Actor of its root Conversation.

#### Scenario: Child access

- **WHEN** a viewer reads a child Conversation
- **THEN** Junior checks access against the Participants of the root
- **AND** `onBehalfOf` provenance does not give access.

#### Scenario: Child Conversation write

- **WHEN** Junior writes a child Conversation
- **THEN** the child row stores no root Actor.

#### Scenario: Child spend

- **WHEN** a Turn in a root or child Conversation uses tokens
- **THEN** People and spend count them for the Actor of that Turn
- **AND** not for the root Actor of the Conversation.

### Requirement: One System Identity

Junior SHALL have exactly one system Identity. Every `SystemActor` and every
`LocalActor` SHALL map to it. `SystemActor.name` SHALL stay runtime
provenance. No plugin and no OAuth link SHALL write the system Identity.

#### Scenario: Different system Actors

- **WHEN** a status event Turn and a scheduled automation Turn each write a
  Message
- **THEN** both Messages have the same system author Identity
- **AND** each Turn keeps its own `SystemActor.name`.

#### Scenario: Legacy per-name system rows

- **WHEN** the data migration runs
- **THEN** the `scheduler`, `local-cli`, and `event` system rows merge into
  the one `system` Identity
- **AND** no dashboard label changes.

#### Scenario: System root labels

- **WHEN** the dashboard shows a root that the system Identity owns
- **THEN** its label comes from the Source or the Automation or dispatch
  record
- **AND** the label does not change to "System".

### Requirement: Web Actors Use The Sign-In Identity

A web Actor SHALL map to the Identity that dashboard sign-in saves for the
viewer User. Junior SHALL NOT create a synthetic web Identity. The mock viewer
SHALL have a mock Identity.

#### Scenario: Signed-in web user sends a Message

- **WHEN** a signed-in dashboard user sends a Message
- **THEN** the Message author is the user's sign-in Identity
- **AND** that Identity links to the viewer's User.

#### Scenario: Mock viewer sends a Message

- **WHEN** the mock viewer sends a Message
- **THEN** the Message author is a mock Identity, not the system Identity
- **AND** Junior writes no Identity row for it.

#### Scenario: Local auth bypass sends a Message

- **WHEN** the dashboard runs with the local auth bypass
- **THEN** the Message author is an Identity of the bypass User
- **AND** that Identity can never match a production User.

### Requirement: Users Have Many Identities

A User SHALL be able to link many Identities. Spend, People, participants,
and Locations SHALL group by User. They SHALL use the Identity only for an
Identity with no User.

#### Scenario: One person on Slack and the web

- **WHEN** a person starts one Conversation in Slack and one on the dashboard
- **THEN** People shows one person with both Conversations
- **AND** Locations shows that person one time.

### Requirement: Bots Have Their Own Identity

A bot SHALL have its own Identity of kind `bot` with no User. A Slack bot
Identity SHALL use the bot user id. That Identity SHALL be the author of the
bot's Messages. A bot SHALL NOT count as a person in spend, People, or
participant access.

#### Scenario: Slack bot posts in a Conversation

- **WHEN** a Slack bot posts a Message that Junior stores
- **THEN** the Message author is the bot's `bot` Identity
- **AND** the bot gets no participant row.

### Requirement: Inbound Event Authors

An inbound event SHALL be a user Message. Its author SHALL be the Identity of
the person or bot who wrote the content. A system event SHALL use the system
Identity. The author Identity SHALL be the same Identity that the OAuth link
writes for that account. An event write SHALL NOT change the `kind` or the User
of an existing Identity. An event SHALL name an author only on its own provider.
An event SHALL NOT change the root Actor or the Turn Actor. An event Message
author SHALL NOT become a participant.

The event author SHALL NOT be the Turn Actor. Event Turns SHALL run as the
system Actor. A Turn's credentials SHALL come only from the grant of the
Watch or the Automation, never from the event author. Junior SHALL still
resolve the author to its Identity and linked User. The author SHALL only
label the Message and feed the trust check.

#### Scenario: Linked author does not lend credentials

- **WHEN** a trusted person whose GitHub account links to a User comments on
  a watched PR
- **THEN** the Turn runs as the system Actor
- **AND** the Turn does not use that person's grants
- **AND** the Message author is that person's GitHub Identity, linked to
  their User.

#### Scenario: GitHub PR comment

- **WHEN** a person comments on a watched PR
- **THEN** the event is a user Message
- **AND** its author is that person's GitHub Identity
- **AND** the person gets no participant row.

#### Scenario: Status event

- **WHEN** a watched PR's checks fail
- **THEN** the event is a user Message
- **AND** its author is the system Identity
- **AND** the event starts a run as today.

#### Scenario: Event names another provider

- **WHEN** an event names an author on a provider that is not its own
- **THEN** the event Message author is the system Identity
- **AND** its text is not trusted text.

#### Scenario: Event author already linked

- **WHEN** a person whose GitHub Identity links a User comments on a watched
  PR
- **THEN** the GitHub Identity keeps its `kind` and its User.

#### Scenario: Old event Message

- **WHEN** an event Message from before this plan has no author Identity
- **THEN** the data migration sets the system Identity as its author.

### Requirement: Trusted Event Authors

An event author SHALL be trusted when Junior verifies their linked account on
an allowed domain, with the same check that Identity dispatch and Slack
ingress use. An event author SHALL also be trusted when the
plugin's `trustedAuthors` list has their login. Every other author SHALL be
untrusted. An unknown sender SHALL NOT be trusted.

An event author's text SHALL NOT be an instruction, even from a trusted
author. The Watch or Automation that the event matched SHALL give the job, and
action review SHALL judge the Turn against it. Only the author's own text
SHALL carry the author. Lines that the author only quotes SHALL stay provider
text.

A trusted linked author SHALL write the event's Message under their Identity.
Batching SHALL keep Messages with different authors apart. Event Messages
SHALL NOT share a Turn with Slack or web Messages. Every event SHALL run.
Core SHALL get only a provider-neutral trusted result. Core SHALL NOT read
provider logins to decide trust.

The author's text SHALL carry the same author attributes as that author's
messages. For an untrusted author, the task input SHALL say that Junior could
not verify the account.

#### Scenario: Linked member on an allowed domain

- **WHEN** a person whose GitHub account links to one current Slack member on
  an allowed domain comments on a watched PR
- **THEN** that person writes the event's Message
- **AND** the comment text is context for the Watch task, with their author
  ID and name.

#### Scenario: Linked member on another domain

- **WHEN** a person whose GitHub account links to a Slack member whose email
  is not on an allowed domain comments on a watched PR
- **THEN** the event runs as system context, marked as not verified.

#### Scenario: Deactivated linked member

- **WHEN** a person whose GitHub account links to a Slack user who is no
  longer an active member comments on a watched PR
- **THEN** the event runs as system context, marked as not verified.

#### Scenario: Author with no linked account

- **WHEN** a person whose GitHub Identity has no linked Slack user, and who
  is not on `trustedAuthors`, comments on a watched PR
- **THEN** the event runs as system context, marked as not verified.

#### Scenario: Quoted text from a trusted author

- **WHEN** a trusted author quotes another person's text in a comment
- **THEN** only the author's own lines carry the author.

#### Scenario: Bot on the trusted authors list

- **WHEN** a bot whose GitHub login is on `trustedAuthors` comments on a
  watched PR
- **THEN** its comment text carries the bot as author, without the
  not-verified mark
- **AND** the bot has no User and gets no participant row.

#### Scenario: Unknown sender

- **WHEN** a sender with no known Identity link and no entry on
  `trustedAuthors` comments on a watched PR
- **THEN** the event runs as system context, marked as not verified.

#### Scenario: Trusted author asks for more work

- **WHEN** a trusted author's comment asks for work that the Watch task does
  not ask for
- **THEN** action review does not take the comment as approval.

### Requirement: Guardian Labels Use The Actor

Junior SHALL give Guardian author labels from the Actor and the Message
provenance. Junior SHALL NOT give a label from the Identity id alone.

#### Scenario: Two system authors

- **WHEN** a Turn runs as one `SystemActor` and a root Message has a system
  author with a different `SystemActor.name`
- **THEN** both authors have the one system Identity
- **AND** Guardian does not label the Message as the Turn Actor's own.

### Requirement: Participants Are Users

A participant row SHALL exist only for an Identity of kind `user` with a
User. The dashboard participant list SHALL use the same rule.

#### Scenario: System Identity in a Conversation

- **WHEN** a Conversation has Messages from the system Identity
- **THEN** the participant list does not show the system Identity.

### Requirement: Identity Id Next To The Actor

Junior SHALL carry the Identity id next to the Actor on the Turn and on each
Message. Junior SHALL NOT add the Identity id inside `Actor`.

#### Scenario: Old worker reads a Turn

- **WHEN** an older worker or an external plugin parses the `Actor` of a new
  Turn
- **THEN** the parse succeeds, because `Actor` has no new field.

### Requirement: No Unknown Message Authors

Every new user Message SHALL have an author Identity. Junior SHALL resolve
the author at ingress and SHALL NOT infer it later. Assistant output is an
event and SHALL NOT need an author Identity.

#### Scenario: Ingress without an author

- **WHEN** code tries to write a new user Message without an author Identity
- **THEN** the write fails.

#### Scenario: System input as a user Message

- **WHEN** a system event, a scheduled automation, a plugin dispatch, or the
  local CLI writes a user Message
- **THEN** the author is the system Identity.

#### Scenario: Assistant output

- **WHEN** Junior writes an assistant Message
- **THEN** it has no author Identity
- **AND** the write succeeds.

#### Scenario: Legacy user Message without a provable author

- **WHEN** the dry run cannot prove the author of a legacy user Message
- **THEN** the Message stays with no author Identity
- **AND** Junior does not guess an author
- **AND** Junior does not use the system Identity for it.

### Requirement: Legacy Data Migrates Only With A Proven Rule

Junior SHALL migrate an old data shape only when special code exists because
of it. Junior SHALL migrate it only with a rule that a read-only dry run
proves. After the migration, Junior SHALL delete that special code. Each
migration and repair SHALL run a dry run first. A production backfill SHALL
NOT run without explicit approval.

#### Scenario: Legacy web Identity

- **WHEN** a legacy `junior/<email>` Identity links to a User
- **THEN** Junior does not migrate it
- **AND** readers group it with the other Identities of that User.

#### Scenario: Expired Redis state

- **WHEN** Redis work state or a Turn checkpoint has an old shape
- **THEN** Junior does not migrate it
- **AND** the fallback for it goes only after the plan's 14-day wait.

#### Scenario: Rule that the dry run does not prove

- **WHEN** the dry run shows that a rule disagrees with rows that were not
  damaged
- **THEN** Junior does not apply that rule
- **AND** those rows stay as they are.

### Requirement: Root Actor Repair Uses Proven Rules

Junior SHALL repair old root Actor damage only for the rules that the dry run
proves. Root Actor repair SHALL be separate from the data migration. Each human
who loses the root SHALL keep access as a participant.

#### Scenario: System root that a human took over

- **WHEN** a root has a `scheduler`, `event`, or `local` Source and a human root
  Actor
- **THEN** the repair sets its root Actor to the `system` Identity
- **AND** the human keeps access as a participant.

#### Scenario: Slack or web root with a system root Actor

- **WHEN** a `slack` or `web` root has a system root Actor
- **THEN** Junior repairs it only when the dry run proves the rule
- **AND** otherwise the root keeps its current root Actor.
