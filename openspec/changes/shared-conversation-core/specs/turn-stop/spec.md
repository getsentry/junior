# Turn Stop

## ADDED Requirements

### Requirement: A Stop Saves A Stop Time

A stop SHALL save the stop input's own `createdAtMs` as the stop time on
the conversation and notify a worker. It SHALL NOT write a turn row or a
request record (Proposed, needs sign-off: P34). A turn SHALL be under the
stop when any input it took in has `createdAtMs` older than the stop time;
a worker SHALL stop it. `startTurn` and a join SHALL refuse input older
than the stop time. A new turn after the stop SHALL run normally.

#### Scenario: Slack stop button

- **WHEN** a person clicks stop
- **THEN** the turn ends `stopped`, the runtime posts "Stopped.", the thread
  stays followed and Watches stay.

#### Scenario: Stop during a sign-in wait

- **WHEN** the turn waits for sign-in
- **THEN** the stop notifies a worker and the turn ends.

#### Scenario: Stop races a turn start

- **WHEN** a stop is saved while a worker starts a turn with older input
- **THEN** the start transaction sees the stop time and refuses that input.

#### Scenario: Turn started after the click

- **WHEN** a person sends a message, clicks stop, and the turn for that
  message starts before `stop()` saves
- **THEN** the turn is under the stop, because its input is older than the
  stop time, and it posts nothing more.

#### Scenario: Older input tries to join

- **WHEN** input older than the stop time reaches a running turn's join
  after the stop is saved
- **THEN** the join refuses it.

#### Scenario: Newer input joined before the stop

- **WHEN** a turn under the stop took in a message newer than the stop
  time
- **THEN** `finishTurn(stopped)` puts that message back in the inbox, its
  record stays `open`, and it runs in a later turn.

### Requirement: Saves Refuse Under A Stop

Every fenced save and every delivery intent save of a turn under the stop
SHALL refuse, except the saves of `finishTurn(stopped)`. The stop SHALL be
compared only with input `createdAtMs`, never with a server time (Proposed,
needs sign-off: P34). Stops across clocks are P44.

#### Scenario: Intent after the stop

- **WHEN** a running worker tries to save a delivery intent after a stop
  was saved
- **THEN** the save is refused, nothing is posted, and the worker calls
  `finishTurn(stopped)`.

### Requirement: Input Older Than A Stop

Person input older than the stop SHALL NOT run. It SHALL be saved to history
as not run, so the person can see it and ask again. Event and agent input
older than the stop SHALL be dropped. Both SHALL end through a closing turn
(Proposed, needs sign-off: P30, P34).

#### Scenario: Event before the stop

- **WHEN** an event arrived before the stop
- **THEN** it is dropped and starts no turn.

### Requirement: Stop After A Post

A stop after the provider accepted a post SHALL end the turn `stopped`, and
the post SHALL stay visible (Decided).

#### Scenario: Stop lands after the post

- **WHEN** a stop arrives after Slack accepted response 1
- **THEN** response 1 stays, the turn ends `stopped`, and no more responses
  are sent.

### Requirement: A Stop Command Never Enters The Inbox

A `stop` or `!stop` message to Junior SHALL call `stop()` and post an ack. It
SHALL NOT start a turn. A thread opt-out SHALL also stop following the
thread.

#### Scenario: Stop for someone else

- **WHEN** a message says `@alice stop`
- **THEN** it is not a stop.

#### Scenario: Older stop

- **WHEN** a stop is older than a newer mention
- **THEN** it does nothing to the newer turn or to newer input that a
  stopped turn took in (I14).

### Requirement: Top-Level Stop Stops The Tree

Every stop of a top-level agent SHALL stop every conversation below it:
Slack stop, dashboard stop, ACP stop and thread opt-out (Decided). Each
conversation's `finishTurn` and closing turns SHALL mark its records
`stopped`.

#### Scenario: Late child result

- **WHEN** a child turn ends after a tree stop
- **THEN** its asked record is `stopped`, no result record is minted, and
  no parent turn starts (Proposed, needs sign-off: P35).

#### Scenario: Result in flight at the stop

- **WHEN** a result minted before a tree stop reaches the parent after it
- **THEN** a closing turn drops it and no parent turn starts.

### Requirement: Stopping A Child

A child stopped by `stopAgent` SHALL send no result (Decided). A child
stopped any other way SHALL send its parent a `stopped` result (Decided),
unless the parent is stopped too (Proposed, needs sign-off: P35). Stopping a
child SHALL stop its own children and cancel its Watches.

#### Scenario: stopAgent

- **WHEN** the parent stops a child with `stopAgent`
- **THEN** the parent gets no result.

#### Scenario: Dashboard stop of a child

- **WHEN** an admin stops a child from the dashboard and the parent still
  runs
- **THEN** the parent gets a `stopped` result.

### Requirement: No New Work Under A Stop

`askChild` and `startTurn` SHALL check the stop time under the parent's SQL
lock and in the start transaction.

#### Scenario: Stopped turn spawns late

- **WHEN** a stopped turn calls `spawnAgent` before it sees the stop
- **THEN** the spawn is refused and nothing starts.

### Requirement: Resumed Plugin-Started Agents Honor Stop

A resumed plugin-started agent SHALL see a saved stop.

#### Scenario: Stop during a pause

- **WHEN** a plugin-started agent is stopped while paused
- **THEN** the next attempt ends it `stopped` and the agent does not run.
