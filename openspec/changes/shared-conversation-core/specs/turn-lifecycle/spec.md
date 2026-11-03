# Turn Lifecycle

## ADDED Requirements

### Requirement: One Open Turn Per Conversation

A conversation SHALL have at most one turn that is `running`, `paused` or
`finishing`. The store SHALL enforce it (Decided: P2).

#### Scenario: Second start

- **WHEN** a worker tries to start a turn while one is open
- **THEN** the store refuses it.

#### Scenario: Cutover from the old turn cursor

- **WHEN** a worker takes the lock and finds an open old-format turn
- **THEN** it moves that turn into the turn row and deletes the old one in
  the same locked step, so two open turns never exist.

### Requirement: The Turn Row Owns Turn Status

The turn row SHALL be the only turn status. It SHALL list the request
records it took in. Other views SHALL compute status from turn rows and
request records (Decided: P2, P3).

#### Scenario: Dashboard status

- **WHEN** the dashboard shows a conversation's status
- **THEN** it reads the open turn row and the last finished turn row.

### Requirement: A Finished Turn Stays Finished

A turn that is `completed`, `failed`, `blocked` or `stopped` SHALL never
change. Only `finishTurn` SHALL write those statuses.

#### Scenario: Late save

- **WHEN** a late save from a lost worker arrives for a finished turn
- **THEN** it is refused.

### Requirement: Worker Lock And Lock Version

A worker SHALL take the lock with one compare-and-set on the conversation
row that raises the lock version (Decided: P5). Every turn
save, history commit and delivery intent SHALL check the token and version
in the same write. A worker whose check fails SHALL stop (Decided). The lock
version SHALL never go down.

#### Scenario: Slow worker save

- **WHEN** a worker that lost its lock reaches a save
- **THEN** the save fails and nothing is written.

#### Scenario: Slow worker post

- **WHEN** a worker that lost its lock reaches a post
- **THEN** its check-in or delivery intent save fails and nothing is
  posted.

### Requirement: Start A Turn In One Transaction

`startTurn` SHALL check the lock and the stop time, create the turn row with
its request ids, and commit the prompt to history in one transaction. A
message SHALL leave the inbox only after that commit. A redelivered message
SHALL reuse its saved copy and turn context, and SHALL NOT load new context.

#### Scenario: Crash between commit and inbox removal

- **WHEN** a worker dies after the commit and before the inbox removal
- **THEN** the next worker removes the message and does not add it again.

### Requirement: History Only Grows

Agent history SHALL grow only at its end, and only through `startTurn` and
`saveCheckpoint`. A write that branches from saved history SHALL be refused.
Compaction and handoff SHALL keep the current instruction and its author and
keep the turn totals.

#### Scenario: Branching write

- **WHEN** a save starts from an older history position
- **THEN** it is refused.

### Requirement: Checkpoint And Continue

A worker SHALL save a checkpoint and release the lock at the next safe point
before its 5-minute attempt limit. The turn SHALL continue on a new worker. A
queue message SHALL carry only the conversation id.

#### Scenario: Hard time limit

- **WHEN** an attempt hits the hard time limit before it saves anything new
- **THEN** the turn pauses `hard_time_limit` again, and the attempt limit
  stops repeats (Proposed, needs sign-off: P10, P11).

### Requirement: A Turn Must Make Progress

A turn that pauses `soft_time_limit` at the boundary it resumed from SHALL
end `failed: no_progress`. A `post_retry` pause SHALL be exempt until its
delivery reaches 5 post attempts; then the turn SHALL end
`failed: post_failed` (Proposed, needs sign-off: P11).

#### Scenario: Same boundary twice

- **WHEN** a resumed attempt pauses `soft_time_limit` at the boundary it
  resumed from
- **THEN** the turn ends `failed: no_progress` with a visible error message.

### Requirement: Per-Turn Limits

A turn SHALL stop at 100 attempts, 1,000 tool calls or $100 cost. Totals
SHALL survive resume, compaction and handoff. A limit SHALL end the turn on
the first try after one wrap-up step, outside the retry limit (Proposed,
needs sign-off: P12).

#### Scenario: Cost limit

- **WHEN** a step goes over the cost limit
- **THEN** that step gets a wrap-up instruction, and the turn ends
  `failed: limit` without a retry.

### Requirement: Retry Limit Per Turn

A turn SHALL have one retry limit (Decided). An error after take-in SHALL
pause the turn `error_retry`, count one error, and release the lock (Proposed,
needs sign-off: P31). The limit SHALL be 5 errors (Proposed, needs
sign-off: P4). Each message SHALL allow 5 delivery attempts before a turn
takes it in. An error before take-in SHALL count a delivery attempt and show
nothing (Proposed, needs sign-off: P22).

#### Scenario: Retries run out

- **WHEN** a turn's fifth error happens
- **THEN** `finishTurn` ends it `failed`, the error message goes to its reply
  targets, and other people's waiting input stays.

#### Scenario: An error is not a lost worker

- **WHEN** an attempt fails with an error and releases the lock
- **THEN** the next worker resumes the `error_retry` pause and does not use
  the restart.

### Requirement: Lost Worker Gets One Restart

After a lost worker, every kind of turn SHALL get one restart from its last
checkpoint (Decided). A turn SHALL count as lost only when it is `running`
and the worker took an expired lock (Proposed, needs sign-off: P8). A
restart SHALL NOT count against the retry limit (Proposed, needs sign-off:
P4).

#### Scenario: Lost twice

- **WHEN** the worker is lost again after the restart, or no attempt is left
- **THEN** the turn ends `failed: lost_worker` with a visible error message.

#### Scenario: Pause save fails

- **WHEN** a worker's pause save fails while the turn is `running`
- **THEN** it does not release the lock, the lock expires, and the repair
  job notifies a worker on its next pass (Proposed, needs sign-off: P8).

### Requirement: The Response Rule

Junior SHALL send each assistant response when it is produced, as its reply
target kind allows. A failed turn SHALL send an error message. Every
turn SHALL end with something the person can see (Decided). The runtime
SHALL NOT split, merge or rewrite responses.

#### Scenario: No reply token

- **WHEN** the agent replies `[[NO_REPLY]]`
- **THEN** nothing is posted.

#### Scenario: Failed turn

- **WHEN** a Slack turn fails on its last try
- **THEN** one error message is posted, except in read-only channels.

### Requirement: Detect Repeat Posts

Each response SHALL have a fixed delivery id. The worker SHALL check in,
save a checkpoint that commits the response to history and records the
intent with its text, post, then save the provider message id. A later
worker SHALL check for the delivery id before it posts again, and SHALL send
the saved text, not new text (Decided: P5). A repeat post
SHALL be detected; it is not prevented.

#### Scenario: Two outcomes, second fails

- **WHEN** the second of two posts fails
- **THEN** the first is not posted again.

#### Scenario: Restart after an intent

- **WHEN** a worker dies after it saved an intent and before it saved the
  provider message id
- **THEN** the next worker asks the provider for the delivery id and posts
  the saved text only if it did not land.

### Requirement: One Way To End A Turn

Every end of a turn SHALL go through `finishTurn`: done, error, stop, no
progress, a limit, the last retry, a lost worker with no restart left,
dropped input, sign-in expiry or supersede. It SHALL record the outcome
once, show it once, move its request records out of `open`, apply the
no-credentials sandbox policy, and write one `turn.terminal` event. It SHALL
be resumable.

#### Scenario: Crash during finish

- **WHEN** a worker dies with the turn `finishing`
- **THEN** the next worker runs `finishTurn` again, checks each saved
  delivery id before it posts, and a repeat post is detected.

#### Scenario: Next turn after a failure

- **WHEN** the next turn runs
- **THEN** a conversation note tells the agent about the failure.

### Requirement: Finishing Always Ends

A delivery that fails while finishing SHALL retry with backoff, up to 5
attempts. A permanent provider error SHALL fail it at once. Then it SHALL
be `failed`, and the turn SHALL finish anyway (Proposed, needs sign-off:
P33).

#### Scenario: Error message cannot be posted

- **WHEN** the error message fails 5 times
- **THEN** the turn ends `failed`, its record is `answered`, and
  `turn.terminal` says the delivery failed.

### Requirement: Closing Turns

Input that will not run SHALL still get a turn row that ends at once,
without the agent (Proposed, needs sign-off: P30).

#### Scenario: Input past its delivery attempts

- **WHEN** a message reaches 5 delivery attempts
- **THEN** a closing turn ends `failed: input_dropped` and sends the error
  message.

### Requirement: One Repair Job

One repair job SHALL resend lost input, stamp records on `accepted`,
`duplicate` or `refused`, stop after 5 attempts or 24 h, and notify workers
for flagged records, past wake times (from a wake-time index) and
`running` turns whose lock expired. It SHALL write no status (Proposed,
needs sign-off: P7).

#### Scenario: Parent turn fails after saving the record

- **WHEN** a record is saved, its input is not added, and the caller fails
- **THEN** after 60 s the repair job sends it again with the fixed inbound
  message id, and the target gets it once.

#### Scenario: Repair gives up

- **WHEN** the repair job reaches its limit for a record
- **THEN** it stamps the record and notifies a worker, which closes it with
  a closing turn.

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
