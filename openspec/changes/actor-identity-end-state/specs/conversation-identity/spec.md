# Conversation Identity

These requirements give the end state. Each step in `tasks.md` decides how to
build them.

## ADDED Requirements

### Requirement: One Owner Per Conversation

Each root Conversation SHALL have one Owner. The Owner SHALL be the Identity
that started the Conversation. Junior SHALL set it one time, at create. Junior
SHALL NOT change it later.

#### Scenario: Human starts a Conversation

- **WHEN** a human starts a Conversation from Slack, the dashboard, or a fork
- **THEN** the Owner is that human's Identity.

#### Scenario: System starts a Conversation

- **WHEN** a scheduled automation, an event automation, a plugin dispatch, or
  the local CLI starts a Conversation
- **THEN** the Owner is the one system Identity
- **AND** the Conversation Source and the Automation or dispatch record tell
  which system started it.

#### Scenario: Human replies to a system Conversation

- **WHEN** a human replies in a Conversation that the system Identity owns
- **THEN** the Owner stays the system Identity
- **AND** the human becomes a participant
- **AND** the human gets access and feed membership as a participant.

### Requirement: Child Conversations Use The Root Owner

A child Conversation SHALL NOT store an Owner. Junior SHALL read the Owner of
its root Conversation.

#### Scenario: Child access

- **WHEN** a viewer reads a child Conversation
- **THEN** Junior checks access against the root Owner and the root
  participants
- **AND** `onBehalfOf` provenance does not give access.

#### Scenario: Child spend

- **WHEN** a child Conversation uses tokens
- **THEN** People and spend count them for the root Owner
- **AND** not for the child's own Actor.

### Requirement: One System Identity

Junior SHALL have exactly one system Identity. Every `SystemActor` and every
`LocalActor` SHALL map to it. `SystemActor.name` SHALL stay runtime
provenance. No plugin and no OAuth link SHALL write the system Identity.

#### Scenario: Different system Actors

- **WHEN** a status event Turn and a scheduled automation Turn each write a
  Message
- **THEN** both Messages have the same system author Identity
- **AND** each Turn keeps its own `SystemActor.name`.

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
writes for that account. An event write SHALL NOT change the `kind` or the
User of an existing Identity. An event SHALL name an author only on its own
provider. An event SHALL NOT change the Owner or the Turn Actor. An event
Message author SHALL NOT become a participant.

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

### Requirement: Trusted Event Authors

An event author SHALL be trusted when Junior verifies their linked account on
an allowed domain, with the same check that Identity dispatch and Watch
requester instructions use. An event author SHALL also be trusted when the
plugin's `trustedAuthors` list has their login. Every other author SHALL be
untrusted. An unknown sender SHALL NOT be trusted.

Junior SHALL treat text from a trusted author exactly like a chat message from
that author, no more and no less. Only the author's own text SHALL count.
Lines that the author only quotes SHALL NOT count.

An event from an untrusted or unknown author SHALL NOT start a run. A system
event SHALL run as today. Core SHALL get only a provider-neutral trusted
result. Core SHALL NOT read provider logins to decide trust.

In an event batch, Junior SHALL decide trust for each entry. An untrusted
entry SHALL NOT start a Turn and SHALL NOT count as instructions. When no
trusted or system entry is left, Junior SHALL NOT start a Turn. Whether
Junior drops untrusted entries or keeps them as context is open
(`proposal.md`, Open Questions, 1).

#### Scenario: Linked member on an allowed domain

- **WHEN** a person whose GitHub account links to one current Slack member on
  an allowed domain comments on a watched PR
- **THEN** Junior treats the comment text like a chat message from that
  person.

#### Scenario: Linked member on another domain

- **WHEN** a person whose GitHub account links to a Slack member whose email
  is not on an allowed domain comments on a watched PR
- **THEN** the event does not start a run.

#### Scenario: Deactivated linked member

- **WHEN** a person whose GitHub account links to a Slack user who is no
  longer an active member comments on a watched PR
- **THEN** the event does not start a run.

#### Scenario: Author with no linked account

- **WHEN** a person whose GitHub Identity has no linked Slack user, and who
  is not on `trustedAuthors`, comments on a watched PR
- **THEN** the event does not start a run.

#### Scenario: Quoted text from a trusted author

- **WHEN** a trusted author quotes another person's text in a comment
- **THEN** Junior treats only the author's own lines as trusted text.

#### Scenario: Bot on the trusted authors list

- **WHEN** a bot whose GitHub login is on `trustedAuthors` comments on a
  watched PR
- **THEN** Junior treats the comment text like a chat message from that bot
- **AND** the bot has no User and gets no participant row.

#### Scenario: Person on the trusted authors list

- **WHEN** a person whose GitHub login is on `trustedAuthors`, and who has no
  allowed-domain email, comments on a watched PR
- **THEN** Junior treats the comment text like a chat message from that
  person.

#### Scenario: Unknown sender

- **WHEN** a sender with no known Identity link and no entry on
  `trustedAuthors` comments on a watched PR
- **THEN** the event does not start a run.

#### Scenario: Bot not on the trusted authors list

- **WHEN** a bot whose GitHub login is not on `trustedAuthors` comments on a
  watched PR
- **THEN** the event does not start a run.

#### Scenario: Batch with only untrusted entries

- **WHEN** one Turn takes a batch where every entry has an untrusted author
- **THEN** no Turn starts.

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

#### Scenario: Legacy Message without an author

- **WHEN** Junior reads a legacy user Message with no author Identity
- **THEN** Junior uses the legacy fallback
- **AND** logs that the fallback ran.

### Requirement: Legacy Rows Stay

Junior SHALL leave legacy Identity and Owner rows as they are, unless a
migration is clearly correct. Each repair or merge SHALL run a dry run first.
A production backfill SHALL NOT run without explicit approval.

#### Scenario: Legacy web Identity with no matching sign-in row

- **WHEN** a legacy `junior/<email>` Identity has no sign-in Identity that
  links the same User
- **THEN** its references stay as they are.
