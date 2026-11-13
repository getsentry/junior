# Code Channel Threads

These requirements give the end state of the experiment. Each step in
`tasks.md` decides how to build them.

## ADDED Requirements

### Requirement: Only Eligible Threads Get A Code Channel

When the `code-channels` experimental feature is on, Junior SHALL open a code
channel for a new Thread only when all of these are true:

- the parent is a root Conversation
- the root's Location is a public Slack channel that is not shared with
  another organization
- the Thread starts from a Slack message in that channel.

Junior SHALL NOT open a code channel for a Task, a root, a Thread below
another Thread, or a Thread that starts inside a code channel.

#### Scenario: Thread from a public channel

- **WHEN** a root in a public Slack channel starts a Thread
- **THEN** Junior creates a code channel linked to the origin message
- **AND** the code channel is the Location of the Thread.

#### Scenario: Task from a public channel

- **WHEN** a root in a public Slack channel starts a Task
- **THEN** Junior does not create a code channel.

#### Scenario: Thread from a DM or private channel

- **WHEN** a root in a DM, group DM, or private channel starts a Thread
- **THEN** Junior does not create a code channel
- **AND** the Thread works as a plain Thread.

#### Scenario: Experiment off

- **WHEN** the `code-channels` experimental feature is off
- **THEN** no Thread gets a code channel.

### Requirement: Fallback To A Plain Thread

When code channel creation fails, Junior SHALL start the Thread as a plain
Thread. Junior SHALL NOT show an error to people for an expected Slack
failure.

#### Scenario: Slack does not allow the app

- **WHEN** `agents.conversations.create` fails with `feature_disabled`
- **THEN** the Thread starts with no Location
- **AND** `spawnAgent` returns the dashboard link and no code channel.

### Requirement: Channel Thread Delivers To Its Code Channel

A channel Thread SHALL deliver the final response of each Turn to its code
channel as a top-level message, unless the Turn ends with `noReply`. This
SHALL apply to a person's Turn, an Agent invocation Turn, a Task result Turn,
and a Watch Event Turn.

#### Scenario: Person asks in the code channel

- **WHEN** a person posts a request for Junior in the code channel
- **THEN** Junior posts its answer as a top-level message in the code
  channel.

#### Scenario: Task result

- **WHEN** a Task that the channel Thread started returns a result
- **THEN** the channel Thread can post about it in the code channel
- **AND** the parent gets no message unless the channel Thread sends one.

### Requirement: Code Channel Messages Go To The Channel Thread

Every message from a person in a code channel SHALL go to its channel Thread,
also without a mention. A mention in a code channel SHALL NOT open another
code channel or start a root Turn.

#### Scenario: People talk to each other

- **WHEN** two people discuss something in the code channel that is not for
  Junior
- **THEN** the channel Thread ends the Turn with `noReply`.

#### Scenario: Question for Junior without a mention

- **WHEN** the requester asks Junior a question in the code channel without a
  mention
- **THEN** Junior answers in the code channel.

### Requirement: The Parent Is Silent By Default

A channel Thread SHALL reach its parent only with `messageAgent`. It SHALL
NOT have a `reply` tool. It SHALL message the parent only when a person or
agent outside the code channel must know or act (`design.md`, Notify The
Parent).

#### Scenario: Progress

- **WHEN** the channel Thread finishes a step of the work
- **THEN** it does not message the parent.

#### Scenario: Blocked on the origin Slack thread

- **WHEN** the work needs an approval from a person who is only in the
  origin Slack thread
- **THEN** the channel Thread messages the parent.

#### Scenario: Parent asks a question

- **WHEN** the parent sends the channel Thread a question
- **THEN** the channel Thread answers the parent with `messageAgent`.

### Requirement: Wrap-Up Message On Archive

When a code channel is archived, the runtime SHALL send one Agent message to
the parent. Its text SHALL be the summary message, or the outcome of the
latest Brief when there is no summary message. The model SHALL NOT decide
whether this message is sent.

#### Scenario: Junior archives after a summary

- **WHEN** a person uses the archive action on Junior's summary
- **THEN** Junior archives the code channel with that summary message
- **AND** the parent gets the summary as an Agent message.

#### Scenario: Person archives in Slack

- **WHEN** a person archives the code channel in Slack
- **THEN** the Thread is archived
- **AND** the parent gets the outcome of the latest Brief.

### Requirement: Origin Slack Thread Stays Quiet

The root SHALL NOT post a message in the origin Slack thread when it starts a
channel Thread. The Slack card is the reply. The root SHALL answer a status
question about an open channel Thread without starting another one.

#### Scenario: Thread starts

- **WHEN** the root starts a channel Thread
- **THEN** the root ends its Turn with `noReply`.

#### Scenario: Status question in the origin Slack thread

- **WHEN** a person asks in the origin Slack thread whether the work is done
- **THEN** the root answers from the channel Thread's status and Brief
- **AND** no new channel Thread starts.

### Requirement: Session Status And Stop

A channel Thread SHALL keep the Slack session status of its code channel
current. A Slack stop for the code channel SHALL stop the channel Thread and
its child agents.

#### Scenario: Junior waits for a person

- **WHEN** a Turn ends with a question for a person or an open review item
- **THEN** the session status is `suspended`.

#### Scenario: Stop button

- **WHEN** a person presses Stop in the code channel
- **THEN** the active Turn stops
- **AND** the child agents of the channel Thread stop.
