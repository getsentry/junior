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
- **THEN** the Message author is a `mock` Identity, not the system Identity
- **AND** Junior writes no Identity row for it.

#### Scenario: Local auth bypass sends a Message

- **WHEN** the dashboard runs with `authRequired: false` and real data
- **THEN** the Message author is the bypass User's `mock` Identity
- **AND** that Identity has the same key as the mock viewer.

#### Scenario: Auth bypass on a production deploy

- **WHEN** the dashboard starts with `authRequired: false` on a Vercel
  production deploy
- **THEN** the dashboard fails to start.

### Requirement: Users Have Many Identities

A User SHALL be able to link many Identities, such as `slack`, `google`, and
`github`. Spend, People, participants, and Locations SHALL group by User. They
SHALL use the Identity only for an Identity with no User.

#### Scenario: One person on Slack and the web

- **WHEN** a person starts one Conversation in Slack and one on the dashboard
- **THEN** People shows one person with both Conversations
- **AND** Locations shows that person one time.

### Requirement: Reserved Identity Providers

Only core SHALL write Identities with provider `junior` or `mock`. An OAuth
account link SHALL NOT write either provider.

#### Scenario: Plugin OAuth link

- **WHEN** a plugin OAuth account links an Identity
- **THEN** its provider is not `slack`, `google`, `junior`, or `mock`.

### Requirement: Slack Bots Have Their Own Identity

A Slack bot SHALL have its own Identity of kind `bot` with no linked User.
Its subject SHALL be the bot user id. That Identity SHALL be the author of
the bot's Messages. A bot SHALL NOT count as a person
in spend, People, or participant access.

#### Scenario: Slack bot posts in a Conversation

- **WHEN** a Slack bot posts a Message that Junior stores
- **THEN** the Message author is the bot's `bot` Identity
- **AND** the bot gets no participant row.

### Requirement: Inbound Event Authors

An inbound event SHALL be a user Message. Its author SHALL be the Identity of
the person or bot that the event names by provider account id. An event that
names no account SHALL use the system Identity. The author Identity SHALL use
the same key as the OAuth account link, and kind `bot` for a bot. Writing the
author Identity SHALL NOT change the `kind` or `user_id` of an existing row.
Junior SHALL verify the author the same way as everywhere else. An event
SHALL NOT change the Owner or the Turn Actor. An event Message author SHALL
NOT become a participant.

#### Scenario: GitHub PR comment

- **WHEN** a person comments on a watched PR
- **THEN** the event is a user Message
- **AND** its author is that person's `github` Identity
- **AND** the author is trusted only when `findLinkedSlackMember()` returns
  `linked` for the account, or the login is on `trustedAuthors`
- **AND** the person gets no participant row.

#### Scenario: Event batch with two authors

- **WHEN** one Turn takes a batch of two events from two different authors
- **THEN** the batch Message author is the system Identity
- **AND** Junior decides trust for each event from its own author Identity.

#### Scenario: Event batch with one author

- **WHEN** one Turn takes a batch of events that all have the same author
- **THEN** the batch Message author is that author Identity.

#### Scenario: Event names another provider

- **WHEN** an event's `doneBy.provider` differs from its `namespace`, or the
  namespace is `slack`, `google`, `junior`, or `mock`
- **THEN** the event Message author is the system Identity
- **AND** its text stays data only.

#### Scenario: Status event

- **WHEN** a watched PR's checks fail
- **THEN** the event is a user Message
- **AND** its author is the system Identity.

#### Scenario: Event author already linked

- **WHEN** a person whose `github` Identity links a User comments on a
  watched PR
- **THEN** the `github` Identity keeps its `kind` and `user_id`.

### Requirement: Trusted Event Authors

Junior SHALL NOT treat text from an untrusted event author as instructions.
An author SHALL be trusted when the plugin marks the author as trusted from
its config, or when `findLinkedSlackMember()` returns `linked` for the
author's account. That check SHALL be the same check that Identity dispatch
and Watch requester instructions use: the exact linked account id, one linked
Slack user, a current human member, and a Slack email on `allowedDomains`.
Every other author SHALL be untrusted, and their text SHALL be data only. The
GitHub plugin SHALL own its trusted authors list of GitHub logins,
`githubPlugin({ trustedAuthors })`. Core SHALL NOT read GitHub logins to
decide trust.

Only `doneByText` SHALL be trusted text, with the lines that the author only
quotes removed. Junior SHALL render it in the `Requester instruction`
section of the task input. Junior SHALL NOT render it as a `user:` line.
What text from a trusted author may authorize waits on the open question
(`proposal.md`, Open Questions).

#### Scenario: Linked member on an allowed domain

- **WHEN** a person whose GitHub account links to one current Slack member on
  an allowed domain comments on a watched PR
- **THEN** Junior treats the comment text as trusted text
- **AND** renders it in the `Requester instruction` section, not as a
  `user:` line.

#### Scenario: Linked member on another domain

- **WHEN** a person whose GitHub account links to a Slack member whose email
  is not on an allowed domain comments on a watched PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Deactivated linked member

- **WHEN** a person whose GitHub account links to a Slack user who is no
  longer an active member comments on a watched PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Author with no linked account

- **WHEN** a person whose `github` Identity has no linked Slack user comments
  on a watched PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Quoted text from a trusted author

- **WHEN** a trusted author quotes another person's text in a comment
- **THEN** Junior treats only the author's own lines as trusted text
- **AND** the quoted lines stay data only.

#### Scenario: Bot on the trusted authors list

- **WHEN** a bot whose GitHub login is on the GitHub plugin trusted authors
  list comments on a watched PR
- **THEN** the plugin marks the author as trusted
- **AND** Junior treats the comment text as trusted text
- **AND** the bot has no User and gets no participant row.

#### Scenario: Person on the trusted authors list

- **WHEN** a person whose GitHub login is on the GitHub plugin trusted
  authors list, and who has no allowed-domain email, comments on a watched PR
- **THEN** the plugin marks the author as trusted
- **AND** Junior treats the comment text as trusted text.

#### Scenario: Unknown sender

- **WHEN** a sender with no known Identity link and no entry on the trusted
  authors list comments on a watched PR
- **THEN** Junior treats the comment text as data only.

#### Scenario: Bot not on the trusted authors list

- **WHEN** a bot whose GitHub login is not on the GitHub plugin trusted
  authors list comments on a watched PR
- **THEN** Junior treats the comment text as data only.

### Requirement: Guardian Labels Use The Actor

Junior SHALL give Guardian author labels from the Actor and the Message
provenance. Junior SHALL NOT give a label from the Identity id alone.

#### Scenario: Two system authors

- **WHEN** a Turn runs as one `SystemActor` and a root Message has a system
  author with a different `SystemActor.name`
- **THEN** both authors have the one system Identity
- **AND** Guardian labels the Message `event`, not `automation`.

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

#### Scenario: System input as a user Message

- **WHEN** a system event with no author, a scheduled automation, a plugin
  dispatch, or the local CLI writes a user Message
- **THEN** the author is the system Identity.

#### Scenario: Assistant output

- **WHEN** Junior writes an assistant Message
- **THEN** the row has no author Identity
- **AND** the write succeeds.

#### Scenario: Legacy Message without an author

- **WHEN** Junior reads a legacy user Message row with no author Identity
- **THEN** Junior uses the legacy fallback
- **AND** logs that the fallback ran.
