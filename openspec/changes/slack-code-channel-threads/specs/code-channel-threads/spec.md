# Code Channel Threads

These requirements give the end state of the experiment. Each step in
`tasks.md` decides how to build them.

## ADDED Requirements

### Requirement: Only Eligible Threads Get A Code Channel

When the `code-channels` experimental feature is on, Junior SHALL open a code
channel for a new Thread only when all of these are true:

- the parent is a root Conversation
- a live `conversations.info` shows the origin channel is public, not shared
  with another organization, and not itself a code channel
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
- **THEN** no new Thread gets a code channel
- **AND** open channel Threads keep their routing, delivery, status, stop,
  and archive, because the binding decides them.

#### Scenario: One per origin Slack thread

- **WHEN** a root with an open channel Thread starts another Thread
- **THEN** `spawnAgent` returns the open channel Thread
- **AND** sends it the new task as a parent message.

### Requirement: Fallback To A Plain Thread

When code channel creation fails, Junior SHALL start the Thread as a plain
Thread. Junior SHALL NOT show an error to people for an expected Slack
failure.

#### Scenario: Slack does not allow the app

- **WHEN** `agents.conversations.create` fails with `feature_disabled`
- **THEN** the Thread starts as a plain Thread in the origin Slack thread
- **AND** `spawnAgent` returns the dashboard link and no code channel.

#### Scenario: The channel exists after an error

- **WHEN** `agents.conversations.create` fails with `invite_failed` or
  `open_failed`
- **THEN** Junior calls it again with the same `session_id` and binds the
  channel that it returns.

### Requirement: Channel Thread Delivers To Its Code Channel

A channel Thread SHALL deliver the final response of each Turn to its code
channel as a top-level message, unless the Turn ends with `noReply`. This
SHALL apply to a person's Turn, a parent message Turn, a Task result Turn,
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

Every message from a person in a bound code channel SHALL go to its channel
Thread, also without a mention and with `passive-routing` off. A mention in
a bound code channel SHALL NOT open another code channel or start a root
Turn. A mention in an unbound code channel SHALL run a root Turn that does
not open a code channel.

#### Scenario: People talk to each other

- **WHEN** two people discuss something in the code channel that is not for
  Junior
- **THEN** the channel Thread ends the Turn with `noReply`.

#### Scenario: Code channel opened from Slack's UI

- **WHEN** a person mentions Junior in a code channel that no Thread owns
- **THEN** a root Turn runs
- **AND** no code channel opens.

#### Scenario: Question for Junior without a mention

- **WHEN** the requester asks Junior a question in the code channel without a
  mention
- **THEN** Junior answers in the code channel.

### Requirement: The Parent Is Silent By Default

A channel Thread SHALL reach its parent only with `messageAgent`. It SHALL
NOT have a `reply` tool. It SHALL message the parent only when a person or
agent outside the code channel must know or act (`design.md`, Notify The
Parent). The runtime SHALL NOT send the parent a `completed` result, a
`replaced` result, or a `failed` notice for a channel Thread. A failure
stays in the code channel. A channel Thread SHALL NOT be in `waiting_on`.

#### Scenario: Turn ends

- **WHEN** a channel Thread Turn ends with final text, or fails
- **THEN** the parent gets no message for it.

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
the parent. Its text SHALL be the outcome of the latest Brief, and it SHALL
say whether the channel Thread already messaged the parent. The model SHALL
NOT decide whether this message is sent. A redelivered archive event SHALL
NOT send a second one.

#### Scenario: Person archives in Slack

- **WHEN** a person archives the code channel in Slack
- **THEN** the Thread and its child agents are archived
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

- **WHEN** a Turn ends with an open review item
- **THEN** the session status is `suspended`
- **AND** otherwise it is `active`.

#### Scenario: Stop button

- **WHEN** a person presses Stop in the code channel, also in a Slack thread
  there
- **THEN** the active Turn stops
- **AND** the child agents of the channel Thread stop
- **AND** Junior posts no ack and makes no `agents.sessions.*` call.

#### Scenario: Stop in the origin Slack thread

- **WHEN** a person stops the root in the origin Slack thread
- **THEN** the channel Thread does not stop.
