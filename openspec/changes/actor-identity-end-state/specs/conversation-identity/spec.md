# Conversation Identity

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
provenance.

#### Scenario: Different system Actors

- **WHEN** a status event Turn and a scheduled automation Turn each write a Message
- **THEN** both Messages have the same system author Identity
- **AND** each Turn keeps its own `SystemActor.name`.

### Requirement: Web Actors Use The Signed-In Identity

A web Actor SHALL map to the `google` Identity that dashboard sign-in saves.
Junior SHALL NOT create a synthetic web Identity.

#### Scenario: Signed-in web user sends a Message

- **WHEN** a signed-in dashboard user sends a Message
- **THEN** the Message author is the user's `google` Identity
- **AND** that Identity links to the viewer's `junior_users` row.

#### Scenario: Mock viewer sends a Message

- **WHEN** the mock viewer sends a Message
- **THEN** the Message author is a mock Identity, not the system Identity.

### Requirement: Slack Bots Have Their Own Identity

A Slack bot SHALL have its own Identity with no linked User. That Identity
SHALL be the author of the bot's Messages. A bot SHALL NOT count as a person
in spend, People, or participant access.

#### Scenario: Slack bot posts in a Conversation

- **WHEN** a Slack bot posts a Message that Junior stores
- **THEN** the Message author is the bot's Identity
- **AND** the bot gets no participant row.

### Requirement: Inbound Event Authors

An inbound event Message from an event with an actor SHALL use the Identity
of that person or bot. An event with no actor SHALL use the system Identity.
Junior SHALL verify the author Identity the same way as everywhere else. An
event SHALL NOT change the Owner. An event author SHALL NOT become a
participant.

#### Scenario: GitHub PR comment

- **WHEN** a person comments on a watched PR
- **THEN** the event Message author is that person's `github` Identity
- **AND** the Identity is verified only when it links to a User
- **AND** the person gets no participant row.

#### Scenario: Status event

- **WHEN** a watched PR's checks fail
- **THEN** the event Message author is the system Identity.

### Requirement: Trusted Event Authors

Junior SHALL treat the text of an event author as instructions only when the
author is trusted. An author SHALL be trusted when the plugin marks the author
as trusted from its config, or when the author's Identity links to a User
whose primary email passes `allowedDomains`. The text of every other author
SHALL be data only. The GitHub plugin SHALL own its trusted authors list of
GitHub logins, `githubPlugin({ trustedAuthors })`. Core SHALL NOT read
GitHub logins to decide trust.

#### Scenario: Linked user on an allowed domain

- **WHEN** a person whose `github` Identity links to a User on an allowed
  domain comments on a watched PR
- **THEN** Junior treats the comment text as instructions.

#### Scenario: Linked user on another domain

- **WHEN** a person whose `github` Identity links to a User whose primary
  email is not on an allowed domain comments on a watched PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Author with no User

- **WHEN** a person whose `github` Identity has no User comments on a watched
  PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Bot on the trusted authors list

- **WHEN** a bot whose GitHub login is on the GitHub plugin trusted authors
  list
  comments on a watched PR
- **THEN** the plugin marks the author as trusted
- **AND** Junior treats the comment text as instructions
- **AND** the bot has no User and gets no participant row.

#### Scenario: Bot not on the trusted authors list

- **WHEN** a bot whose GitHub login is not on the GitHub plugin trusted
  authors list
  comments on a watched PR
- **THEN** Junior treats the comment text as data only.

### Requirement: Participants Are Users

A participant row SHALL exist only for an Identity of kind `user` with a
User. The dashboard participant list SHALL use the same rule.

#### Scenario: System Identity in a Conversation

- **WHEN** a Conversation has Messages from the system Identity
- **THEN** the participant list does not show the system Identity.

### Requirement: Identity Id Next To The Actor

Junior SHALL store the Identity id next to the Actor on the Turn and on each
Message. Junior SHALL NOT add the Identity id inside `Actor`.

#### Scenario: Old worker reads a Turn

- **WHEN** an older worker or an external plugin parses the `Actor` of a new
  Turn
- **THEN** the parse succeeds, because `Actor` has no new field.

### Requirement: No Unknown Message Authors

Every new user Message row SHALL have an author Identity. A user Message has
role `user`. Junior SHALL resolve the author at ingress and SHALL NOT infer it
later. Assistant output is an event and SHALL NOT need an author Identity.

#### Scenario: Ingress without an author

- **WHEN** code tries to write a new user Message without an author Identity
- **THEN** the write fails.

#### Scenario: System prompt as a user Message

- **WHEN** an event, a scheduled automation, a plugin dispatch, or the local
  CLI writes a user Message
- **THEN** the author is the system Identity.

#### Scenario: Assistant output

- **WHEN** Junior writes an assistant Message
- **THEN** the row has no author Identity
- **AND** the write succeeds.

#### Scenario: Legacy Message without an author

- **WHEN** Junior reads a legacy user Message row with no author Identity
- **THEN** Junior uses the legacy fallback
- **AND** logs that the fallback ran.
