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

### Requirement: One System Identity

Junior SHALL have exactly one system Identity. Every `SystemActor` and every
`LocalActor` SHALL map to it. `SystemActor.name` SHALL stay runtime
provenance.

#### Scenario: Different system Actors

- **WHEN** an Event Turn and a scheduled automation Turn each write a Message
- **THEN** both Messages have the same system author Identity
- **AND** each Turn keeps its own `SystemActor.name`.

### Requirement: Web Actors Use The Signed-In Identity

A web Actor SHALL map to the `google` Identity that dashboard sign-in saves.
Junior SHALL NOT create a synthetic web Identity.

#### Scenario: Signed-in web user sends a Message

- **WHEN** a signed-in dashboard user sends a Message
- **THEN** the Message author is the user's `google` Identity
- **AND** that Identity links to the viewer's `junior_users` row.

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
