# Turn Stop

## ADDED Requirements

### Requirement: Stop Is Saved And Keyed By Turn

A stop SHALL be saved on the open turn record, keyed by its turn id. It
SHALL reach a running, paused or restarted turn on any worker. An old stop
SHALL NOT stop a new turn. The turn SHALL end `stopped` with no more
assistant responses. Only person input waiting at stop time SHALL be
removed.

#### Scenario: Slack stop button

- **WHEN** a person clicks stop
- **THEN** the turn ends `stopped`, the runtime posts "Stopped.", the thread
  stays followed and Watches stay.

#### Scenario: Stop during a sign-in wait

- **WHEN** the turn waits for sign-in
- **THEN** the stop notifies a worker and the turn ends.

#### Scenario: Stop races a pause

- **WHEN** a stop arrives while the turn saves a pause
- **THEN** the conversation stays runnable so that the stop is seen.

### Requirement: Stop After A Post

A stop after the provider accepted a post SHALL end the turn `stopped`, and
the post SHALL stay visible (Decided).

#### Scenario: Stop lands after the post

- **WHEN** a stop arrives after Slack accepted response 1
- **THEN** response 1 stays, the turn ends `stopped`, and no more responses are sent.

### Requirement: A Stop Command Never Enters The Inbox

A `stop` or `!stop` message to Junior SHALL stop the turn and post an ack.
It SHALL NOT start a turn. Input older than the stop SHALL be dropped,
including events. A thread opt-out SHALL also stop following the thread.

#### Scenario: Stop for someone else

- **WHEN** a message says `@alice stop`
- **THEN** it is not a stop.

#### Scenario: Older stop

- **WHEN** a stop is older than a newer mention
- **THEN** it does nothing to the newer turn.

### Requirement: Top-Level Stop Stops The Tree

Every stop of a top-level agent SHALL stop every conversation below it:
Slack stop, dashboard stop, ACP stop and thread opt-out (Decided). Every open
request record in the tree SHALL become `stopped`.

#### Scenario: Late child result

- **WHEN** a child result arrives after a tree stop
- **THEN** it is dropped and starts no top-level turn.

### Requirement: Stopping A Child

A child stopped by `stopAgent` SHALL send no result. A child stopped any
other way SHALL send its parent a `stopped` result (Decided). Stopping a
child SHALL stop its own children and cancel its Watches.

#### Scenario: stopAgent

- **WHEN** the parent stops a child with `stopAgent`
- **THEN** the parent gets no result.

### Requirement: Resumed Plugin-Started Agents Honor Stop

A resumed plugin-started agent SHALL see a saved stop.

#### Scenario: Stop during a pause

- **WHEN** a plugin-started agent is stopped while paused
- **THEN** the next attempt ends it `stopped` and the agent does not run.
