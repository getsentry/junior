# Conversation Inbox

## ADDED Requirements

### Requirement: Save Before Ack

The core SHALL save input to the inbox before it tells the provider that the
input arrived. `send()` SHALL only add to the inbox and notify a worker.

#### Scenario: Inbox save fails

- **WHEN** the inbox save fails
- **THEN** the provider gets an error and sends the input again.

#### Scenario: Worker notification fails

- **WHEN** the save works but the queue send fails
- **THEN** the input stays, and a retry or the timer job notifies a worker.

### Requirement: Accept Each Message Once

The core SHALL accept each inbound message id once per conversation. The id
SHALL come from the source's own id.

#### Scenario: Provider retry

- **WHEN** a provider sends the same message again
- **THEN** there is no second inbound message and no second turn start.

#### Scenario: Copy while pending

- **WHEN** a copy arrives while the first is still waiting
- **THEN** the core notifies a worker once more
- **AND** a Slack copy with new attachments or a mention upgrades the
  waiting entry (attachments added, wait changed to join now) and keeps its
  timestamps.

### Requirement: Inbound Message Fields

An inbound message SHALL carry its source, join now or wait, sent time,
arrival time, delivery attempt count, event kind and request id
(Proposed, needs sign-off: P9).

#### Scenario: Ordering needs the fields

- **WHEN** the worker orders the inbox
- **THEN** it reads only these fields and the request records.

### Requirement: Stable Order And Priority

The core SHALL order waiting input by sent time, then arrival time, then id.
It SHALL pick join-now input before wait input, and input from people before
events. Input from people SHALL NOT wait for an event window.

#### Scenario: Out of order arrival

- **WHEN** two messages arrive out of order
- **THEN** the worker sees them in the order they were sent.

#### Scenario: Person during an event window

- **WHEN** an event window ends in 30 s and a person writes
- **THEN** the worker runs the person's input now.

### Requirement: One Actor, One Access, One Source Per Turn

A turn SHALL take in only a contiguous run of waiting input with the same
actor, the same whose-access and the same source (Decided).

#### Scenario: Interleaved people

- **WHEN** A1, B1, A2 wait
- **THEN** three turns run, in that order.

#### Scenario: Web and event input

- **WHEN** web input and event input wait together
- **THEN** they run in separate turns.

#### Scenario: Mixed-access event batch

- **WHEN** events from Watches with different timer creators wait in one
  window
- **THEN** they split into one turn per actor and whose-access, in order of
  first arrival (Proposed, needs sign-off: P20).

### Requirement: Event Window

The core SHALL wait until 30 s after the first event in a batch, plus 5 s for
each extra event, up to 60 s. Then one turn takes in the batch.

#### Scenario: Three check runs

- **WHEN** three check runs land on one pull request inside the window
- **THEN** one turn takes in all three.

### Requirement: Admission Before Send

A source SHALL admit input before `send()`. The same check SHALL cover input
that starts a turn and input that would join one. Slack authors SHALL be
verified workspace members, not Junior, and on an allowed domain when one is
set. When no allowed domains are set, any workspace bot SHALL be admitted
(Decided).

#### Scenario: Outsider

- **WHEN** a Slack Connect outsider mentions Junior
- **THEN** the input is dropped before it is saved and before a reaction.

#### Scenario: Untrusted event author

- **WHEN** an event comes from an unverified or untrusted author
- **THEN** ingress drops it with a recorded reason, and no request record is
  made (Decided: discard; Proposed, needs sign-off: P19 for where).

#### Scenario: Bot loop

- **WHEN** another bot and Junior reply to each other in a thread
- **THEN** bot input counts toward the automated-turn limit (Proposed, needs
  sign-off: P27).

### Requirement: Join Now And Wait

A Slack mention or `!!` message SHALL be join now. Other input SHALL be
wait. A dashboard user SHALL be able to change their own waiting message to
join now.

#### Scenario: DM follow-up during a turn

- **WHEN** a DM follow-up with no mention arrives during a turn
- **THEN** it is wait input and runs in the next turn.

### Requirement: Who May Join A Running Turn

Waiting input SHALL join a running turn only at a safe point and only when
`canJoin` holds: same actor, same whose-access, same source, and join now
(or join now or wait for child agents). Events, plugin-started input and
results SHALL never join (Decided). Joined input SHALL keep its own author
in history. The turn SHALL keep its starting actor.

#### Scenario: Another person

- **WHEN** person B writes in A's thread during A's turn
- **THEN** B's message waits for its own turn (Decided).

#### Scenario: Plain reply from the turn's own person

- **WHEN** A sends a plain Slack reply (wait) during A's turn
- **THEN** it waits for the next turn (Decided)
- **AND** the user docs say so.

#### Scenario: Event during a turn

- **WHEN** an event arrives during a turn
- **THEN** it waits.

### Requirement: A Paused Turn Goes First

While a paused turn waits to resume, new wait input SHALL wait behind it. A
joined web message SHALL NOT start a second turn.

#### Scenario: Deferred message on a paused conversation

- **WHEN** a conversation is paused and a wait message arrives
- **THEN** the resume runs first.

### Requirement: Limit On Automated Turns

The core SHALL stop admitting events and top-level agent messages after 25
automated turns in a row with no turn from a person, and post one notice. A
turn from a person SHALL reset the count. A child result SHALL skip the
check but count toward it (Decided).

#### Scenario: Agent message at the limit

- **WHEN** an agent message targets a conversation that is at the limit
- **THEN** `send()` refuses it.

### Requirement: Location And Visibility Are Set Once

A conversation's Location and visibility SHALL be set at create and SHALL
NOT change. ACP and CLI SHALL be private. Web SHALL be public by default.
Slack SHALL take it from the channel. A child SHALL read its root's.

#### Scenario: Different Location

- **WHEN** input names a different Location
- **THEN** `send()` refuses it.

### Requirement: ACP Takes One Prompt At A Time

A conversation with `whenBusy: refuse` SHALL refuse new input while a turn
is open, including one that waits for sign-in. A copy with the same
idempotency key SHALL return the earlier message.

#### Scenario: Prompt while busy

- **WHEN** an ACP prompt arrives while a turn is open
- **THEN** it is refused as busy.

### Requirement: Visible Receipt For Slack Input

Junior SHALL add the processing reaction to a new mention or DM before it
saves the input, never to a copy or stopped input. It SHALL remove it if the
input was not kept, complete it when the turn ends, and clear it on stop.

#### Scenario: Mention waits behind a turn

- **WHEN** a mention waits behind a running turn
- **THEN** it already shows the processing reaction.

### Requirement: The CLI Uses The Inbox

CLI top-level turns SHALL go through `send()` and `work()` with the local
store (Decided).

#### Scenario: Duplicate CLI input

- **WHEN** the CLI sends the same message id twice
- **THEN** one turn runs.

### Requirement: Missing Request Record

Input whose stored request record is missing or invalid SHALL be dropped
with a recorded reason. The core SHALL NOT fill in an actor from another
source (Proposed, needs sign-off: P26).

#### Scenario: Record deleted

- **WHEN** a waiting message points to a request record that does not exist
- **THEN** the message is dropped with a recorded reason and no turn starts.
