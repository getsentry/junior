# Turn Lifecycle

## ADDED Requirements

### Requirement: One Open Turn Per Conversation

A conversation SHALL have at most one turn that is `running`, `paused` or
`finishing`. The store SHALL enforce it (Proposed, needs sign-off: P2).

#### Scenario: Second start

- **WHEN** a worker tries to start a turn while one is open
- **THEN** the store refuses it.

### Requirement: The Turn Record Owns Turn Status

The turn record SHALL be the only turn status. It SHALL list the request
records it took in. Other records SHALL compute their status from it or from
request records (Proposed, needs sign-off: P2, P3).

#### Scenario: Dashboard status

- **WHEN** the dashboard shows a conversation's status
- **THEN** it reads the open turn row and the last finished turn row.

### Requirement: A Finished Turn Stays Finished

A turn that is `completed`, `failed`, `blocked` or `stopped` SHALL never
change. Only `finishTurn` SHALL write those statuses.

#### Scenario: Late save

- **WHEN** a late save from a lost worker arrives for a finished turn
- **THEN** it is refused.

### Requirement: Lock Version On Every Save And Post

Every turn save, history commit and post SHALL carry the worker's lock
version. A save or post with an old version SHALL be refused, and that
worker SHALL stop (Decided). The lock version SHALL be raised in the same
store as the turn row (Proposed, needs sign-off: P5).

#### Scenario: Slow worker

- **WHEN** a worker that lost its lock reaches a save
- **THEN** the save fails and nothing is written.

#### Scenario: Slow worker post

- **WHEN** a worker that lost its lock reaches a post
- **THEN** the delivery intent save fails and nothing is posted.

### Requirement: Take In Before Removing From The Inbox

A message SHALL be removed from the inbox only after the turn row lists its
request id. A redelivered message SHALL reuse its saved copy and turn context.
It SHALL NOT add a second copy or load new context.

#### Scenario: Crash between save and removal

- **WHEN** a worker dies after the save and before the inbox removal
- **THEN** the next worker removes the message and does not add it again.

### Requirement: History Only Grows

Agent history SHALL grow only at its end. A write that branches from saved
history SHALL be refused. Compaction and handoff SHALL keep the current
instruction and its author and keep the turn totals.

#### Scenario: Branching write

- **WHEN** a save starts from an older history position
- **THEN** it is refused.

### Requirement: Checkpoint And Continue

A worker SHALL save a checkpoint and give back the lock at the next safe
point before its 5-minute limit. The turn SHALL continue on a new worker. A
queue message SHALL carry only the conversation id.

#### Scenario: Hard time limit

- **WHEN** an attempt hits the hard time limit before it saves anything new
- **THEN** the turn pauses `hard_time_limit` again, and the slice limit
  stops repeats (Proposed, needs sign-off: P10, P11).

### Requirement: A Turn Must Make Progress

A turn that pauses `soft_time_limit` or `post_retry` at the boundary it
resumed from SHALL fail with `no_progress` (Proposed, needs sign-off: P11).

#### Scenario: Same boundary twice

- **WHEN** a resumed attempt pauses `soft_time_limit` at the boundary it resumed from
- **THEN** the turn ends `failed: no_progress` with a visible error message.

### Requirement: Per-Turn Limits

A turn SHALL stop at 100 slices, 1,000 tool calls or $100 cost. Totals SHALL
survive resume, compaction and handoff. A limit SHALL end the turn on the
first try after one wrap-up step, outside the retry limit (Proposed, needs
sign-off: P12).

#### Scenario: Cost limit

- **WHEN** a step goes over the cost limit
- **THEN** that step gets a wrap-up instruction, and the turn ends `failed: limit`
  without a retry.

### Requirement: Retry Limit Per Turn

A turn SHALL allow 5 errors after its input was taken in. Each message SHALL
allow 5 delivery attempts before a turn takes it in (Decided). An error
before take-in SHALL count a delivery attempt and show nothing (Proposed,
needs sign-off: P22).

#### Scenario: Retries run out

- **WHEN** a turn's fifth error happens
- **THEN** `finishTurn` ends it `failed`, the error message goes to its reply
  targets, and other people's waiting input stays.

### Requirement: Lost Worker Gets One Restart

After a lost worker, every kind of turn SHALL get one restart from its last
checkpoint (Decided). The timer job SHALL only clear the expired lock and
notify a worker. The next worker SHALL restart or fail the turn (Proposed,
needs sign-off: P8). A restart SHALL NOT count against the retry limit
(Proposed, needs sign-off: P4).

#### Scenario: Lost twice

- **WHEN** the worker is lost again after the restart, or no slice is left
- **THEN** the turn ends `failed` with a visible error message.

### Requirement: The Response Rule

Junior SHALL send each assistant response when it is produced. A failed turn
SHALL send an error message. Every turn SHALL end with something the person
can see (Decided). The runtime SHALL NOT split, merge or rewrite responses.

#### Scenario: No reply token

- **WHEN** the agent replies `[[NO_REPLY]]`
- **THEN** nothing is posted.

#### Scenario: Failed turn

- **WHEN** a Slack turn fails on its last try
- **THEN** one error message is posted, except in read-only channels.

### Requirement: Never Post Twice

Each response SHALL have a fixed delivery id. The worker SHALL save the
intent before the post and the provider message id after. A later worker
SHALL check for the delivery id before it posts again (Proposed, needs
sign-off: P5).

#### Scenario: Two outcomes, second fails

- **WHEN** the second of two posts fails
- **THEN** the first is not posted again.

### Requirement: One Way To End A Turn

Every end of a turn SHALL go through `finishTurn`: done, error, stop, no
progress, a limit, the last retry, a lost worker with no restart left,
dropped input, sign-in expiry or supersede. It SHALL record the outcome
once, show it once, revoke the sandbox pass, update request records, and
write one `turn.terminal` event. It SHALL be resumable.

#### Scenario: Crash during finish

- **WHEN** a worker dies with the turn `finishing`
- **THEN** the next worker runs `finishTurn` again and sends nothing twice.

#### Scenario: Next turn after a failure

- **WHEN** the next turn runs
- **THEN** a conversation note tells the agent about the failure.

### Requirement: Usage And Route Belong To The Turn

Usage and duration SHALL add up across attempts without double counting. A
new turn SHALL be routed again. A resumed turn SHALL keep its route.

#### Scenario: Older paused turn ends later

- **WHEN** an older paused turn ends after a newer turn wrote usage
- **THEN** each keeps its own totals and status.

### Requirement: Action Review Does Not Pause

When action review returns ask or deny, the turn SHALL NOT pause. The agent
ends with a question or explanation; a child calls `reportBlocked`. When
action review is not available, the turn SHALL fail.

#### Scenario: Deny in a child

- **WHEN** action review denies a child's tool call
- **THEN** the child calls `reportBlocked` and the turn ends `blocked`.
