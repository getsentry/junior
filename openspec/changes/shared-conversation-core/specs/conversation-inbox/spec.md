# Conversation Inbox

## ADDED Requirements

### Requirement: Save Before Ack

Core ingress SHALL save the request record before it tells the provider
that the input arrived. The record SHALL be the inbox entry: the inbox is
the `open` records with no `turnId`. There SHALL be no other inbox store
(Decided: P23). `send()` SHALL only insert the record, set the wake time
and notify a worker.

#### Scenario: Record save fails

- **WHEN** the record save fails
- **THEN** the provider gets an error and sends the input again
- **AND** the retry saves the record once, unique on
  `(conversationId, inboundMessageId)`.

#### Scenario: Worker notification fails

- **WHEN** the save works but the queue send fails
- **THEN** the input stays, and the repair job notifies a worker
  (Decided: P7, P32).

### Requirement: Core Mints Request Records

Core SHALL mint a request record for every input, with an id in its own
namespace (Decided: P23, P26). The record SHALL store the
conversation id and the inbound message id. Only core person ingress
(Slack, web, ACP, CLI) SHALL make a record with a person actor.

#### Scenario: Plugin input

- **WHEN** a plugin starts a run
- **THEN** core mints the record with the plugin's system actor, and the
  plugin never chooses the request id.

### Requirement: Results Get Their Own Record

A child result or parent message SHALL get its own record in the receiving
conversation, with `answers` and `sentBy`. The child's own save SHALL
insert it: the finishing save for a result, the fenced save of the call
for a parent message. That transaction SHALL lock the parent row before the
child row. No message SHALL point at a record (Decided: P26).

#### Scenario: Result from a turn that is not a child

- **WHEN** a result record's `sentBy` turn row is not in a child of the
  receiving conversation
- **THEN** the worker drops it with reason `sender_mismatch`, starts no
  turn, and fills in no actor from another source.

#### Scenario: Crash after the finishing save

- **WHEN** a child's worker dies after its finishing save commits and
  before it marks the asked records `answered`
- **THEN** the parent already has the result record, and the next worker
  finishes the turn and makes no second one.

#### Scenario: Result record

- **WHEN** a child turn ends with a result for its parent
- **THEN** the parent gets one record in its own conversation, with
  `answers` naming the asked records and `sentBy` naming the child's turn.

### Requirement: Copies Of A Verified Person Actor

Besides core person ingress, the only sources of a `VerifiedPersonActor`
SHALL be the result-record copy and the cutover move (P45). Both SHALL copy
it from verified stored state.

#### Scenario: Result record for a person's request

- **WHEN** a child result answers a record whose actor is a person
- **THEN** the result record copies that verified actor, and nothing else
  makes one.

### Requirement: Accept Each Message Once

The core SHALL accept each inbound message id once per conversation. The id
SHALL come from the source's own id. A unique constraint on
`(conversationId, inboundMessageId)` SHALL be the one duplicate check
(Decided: P23).

#### Scenario: Provider retry

- **WHEN** a provider sends the same message again
- **THEN** the unique key makes it a duplicate: there is no second record
  and no second turn start.

#### Scenario: Copy while waiting

- **WHEN** a copy arrives while the first is still waiting
- **THEN** the core notifies a worker once more
- **AND** a Slack copy with new attachments or a mention upgrades the
  waiting record (files added, `wait` changed to `now`) and keeps its
  timestamps.

### Requirement: Inbound Message Fields

A request record SHALL carry its source, `join` (`now` or `wait`), sent
time, receive time (`receivedAtMs`), delivery attempt count and event kind
(Decided: P9).

#### Scenario: Ordering reads only these fields

- **WHEN** the worker orders the inbox
- **THEN** it reads only these fields and the request records.

### Requirement: Stable Order And Priority

The core SHALL order waiting input by sent time, then arrival time, then id.
It SHALL pick `join: now` input before `wait` input, and input from people
before events. Input from people SHALL NOT wait for an event window.

#### Scenario: Out of order arrival

- **WHEN** two messages arrive out of order
- **THEN** the worker sees them in the order they were sent.

#### Scenario: Person during an event window

- **WHEN** an event window ends in 30 s and a person writes
- **THEN** the worker runs the person's input now.

### Requirement: One Actor, One Access, One Source Per Turn

A turn SHALL take in only a contiguous run of waiting input with the same
actor, exactly the same signed subject (scope included) and the same source
(Decided: P20).

#### Scenario: Interleaved people

- **WHEN** A1, B1, A2 wait
- **THEN** three turns run, in that order.

#### Scenario: Web and event input

- **WHEN** web input and event input wait together
- **THEN** they run in separate turns.

#### Scenario: Events with different access

- **WHEN** events from two Watches with different signed subjects wait in
  one window
- **THEN** inbox selection groups them by actor and exact signed subject
  before a turn starts, one turn per group in order of first arrival, and
  no turn holds mixed access (Decided: P20).

### Requirement: Event Window

The core SHALL wait until 30 s after the first event in a batch, plus 5 s for
each extra event, up to 60 s. Then one turn takes in the batch.

#### Scenario: Three check runs

- **WHEN** three check runs land on one pull request inside the window
- **THEN** one turn takes in all three.

### Requirement: Admission Before Ingress Saves

A source SHALL admit input before it saves anything. The same check SHALL
cover input that starts a turn and input that would join one. Slack authors
SHALL be verified workspace members, not Junior, and on an allowed domain
when one is set. When no allowed domains are set, any workspace bot SHALL be
admitted (Decided).

#### Scenario: Outsider

- **WHEN** a Slack Connect outsider mentions Junior
- **THEN** the input is dropped before it is saved and before a reaction.

#### Scenario: Untrusted event author

- **WHEN** an event comes from an unverified or untrusted author
- **THEN** ingress drops it with a recorded reason, and no request record is
  made (Decided: P19).

### Requirement: Join Now And Wait

A Slack mention or `!!` message SHALL be `join: now`. Other input SHALL be
`wait`. A dashboard user SHALL be able to change their own waiting message to
`now`.

#### Scenario: DM follow-up during a turn

- **WHEN** a DM follow-up with no mention arrives during a turn
- **THEN** it is `wait` input and runs in the next turn.

### Requirement: Who May Join A Running Turn

Waiting input SHALL join a running turn only at a safe point and only when
`canJoin` holds. Events, plugin-started input and results SHALL never join
(Decided). Joined input SHALL keep its own author in history. The turn
SHALL keep its starting actor.

#### Scenario: Another person

- **WHEN** person B writes in A's thread during A's turn
- **THEN** B's message waits for its own turn (Decided).

#### Scenario: Plain reply from the turn's own person

- **WHEN** A sends a plain Slack reply (`wait`) during A's turn
- **THEN** it waits for the next turn (Decided)
- **AND** the user docs say so.

#### Scenario: Event during a turn

- **WHEN** an event arrives during a turn
- **THEN** it waits.

### Requirement: A Paused Turn Goes First

While a paused turn waits to resume, new `wait` input SHALL wait behind it.
A joined web message SHALL NOT start a second turn.

#### Scenario: Wait message on a paused conversation

- **WHEN** a conversation is paused and a `wait` message arrives
- **THEN** the resume runs first.

### Requirement: No Lost Wakes

`send()` SHALL lock the conversation row, insert the record and set the
wake time to now in one transaction, then notify a worker. The release
SHALL lock the same row, read the open turn and the inbox, set the wake
time to `nextRunAtMs` with the same runnable test as `work()`, and clear
the lock expiry in one transaction. After it commits, it SHALL notify a
worker when work is due, or queue a delayed notify (Decided: P32).

#### Scenario: Message while the lock is held

- **WHEN** a message commits while another worker holds the lock, and that
  worker then releases
- **THEN** the release reads the message, sets the wake time to now, and
  notifies a worker.

#### Scenario: Message during the release

- **WHEN** a message's `send()` waits on the row lock that the release holds
- **THEN** it sets the wake time to now after the release commits, and its
  notify finds the lock free.

### Requirement: Limit On Automated Turns

`createRequest` SHALL refuse events and top-level agent messages after 25
automated turns in a row with no turn from a person, before it saves
anything, and post one notice. A
turn from a person SHALL reset the count. A child result SHALL skip the
check but count toward it (Decided).

#### Scenario: Agent message at the limit

- **WHEN** an agent message targets a conversation that is at the limit
- **THEN** `createRequest` throws before it saves anything, and
  `messageAgent` gets the error at once.

### Requirement: Location And Visibility Are Set Once

A conversation's Location and visibility SHALL be set at create and SHALL
NOT change. ACP and CLI SHALL be private. Web SHALL be public by default.
Slack SHALL take it from the channel. A child SHALL read its root's.

#### Scenario: Child conversation

- **WHEN** a child conversation is created
- **THEN** it takes its root's Location and visibility, and nothing changes
  them later.

### Requirement: ACP Takes One Prompt At A Time

ACP ingress SHALL refuse a new prompt while the conversation has an open
turn, including one that waits for sign-in, before it calls
`createRequest`. A copy with the same inbound message id SHALL be a
duplicate of the earlier record. `send()` SHALL NOT refuse input.

#### Scenario: Prompt while busy

- **WHEN** an ACP prompt arrives while a turn is open
- **THEN** ACP ingress refuses it as busy and saves no record.

### Requirement: Visible Receipt For Slack Input

Junior SHALL add the processing reaction to a new mention or DM before it
saves the input, never to a copy or stopped input. It SHALL remove it if the
input was not kept, complete it when the turn ends, and clear it on stop.

#### Scenario: Mention waits behind a turn

- **WHEN** a mention waits behind a running turn
- **THEN** it already shows the processing reaction.

### Requirement: The CLI Uses The Inbox

CLI top-level turns SHALL go through core person ingress and `work()` with
the local store (Decided).

#### Scenario: Duplicate CLI input

- **WHEN** the CLI sends the same message id twice
- **THEN** one turn runs.
