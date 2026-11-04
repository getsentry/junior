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

### Requirement: Cutover Under A Rolling Deploy

The cutover SHALL run a conversation on one core at a time while old and
new workers run together, with no operator step (Decided: P45, P47). The
root conversation SHALL decide `core`, and a child SHALL inherit it. A move
SHALL start only after the stale lease fence, and then SHALL pin today's
lease. A revert deploy SHALL move new-core conversations back by itself.

#### Scenario: Old worker refuses a new-core conversation

- **WHEN** a today's worker from step 3 on takes work for a new-core
  conversation while a new-core deployment is current
- **THEN** it refuses it, acks, runs nothing and sends nothing.

#### Scenario: Pin outlives the move

- **WHEN** the move has run and an old worker reads today's lease
- **THEN** it finds the pin (`expiresAtMs = Number.MAX_SAFE_INTEGER`, a
  fixed token) live, and each new-core lock take refreshes the record's
  7-day TTL.

#### Scenario: New-core worker on a deployment that is not current

- **WHEN** a new-core worker gets a notify on a deployment that is not in
  the current-deployment row
- **THEN** it takes no lock, sends nothing and acks, and the repair job on
  the current deployment runs the conversation.

#### Scenario: Revert moves conversations back

- **WHEN** a revert deploy makes a release without `new_core` current, and
  the heartbeat cron has written it to the current-deployment row
- **THEN** the next lock take on each new-core conversation finishes its
  open turn and records with the new core's `work()`, then sets
  `core = old`, and today's timer job wakes paused new-core turns so this
  needs no new input.

#### Scenario: Move back after a crashed move

- **WHEN** a move crashed after its insert and before its Redis delete,
  and a revert deploy then moves the conversation back
- **THEN** the move back first deletes each Redis turn cursor that has a
  turn row (keyed by turn id) and each waiting input that has a request
  record (keyed by `(conversationId, inboundMessageId)`), then sets
  `core = old`, so today's core runs none of that state again.

#### Scenario: Move back after an abandoned half-moved turn

- **WHEN** a move crashed after its insert, `abandonTurnRecord` then ended
  the Redis cursor, and a revert deploy then moves the conversation back
- **THEN** the move back runs the C10 delete before `work()`, ends the open
  turn row through `finishTurn` with the cursor's end status, and runs no
  turn (C12).

#### Scenario: Revert take waits out today's lease

- **WHEN** a new-core take set `core = new` and waited on today's live
  lease without a pin, and a revert deploy then makes a release without
  `new_core` current
- **THEN** the revert's lock take first passes the stale lease fence and
  pins, in the C11 read order, and only then runs `work()` on the new
  core's inbox, so no input runs on the new core while today's holder
  runs (C14).

#### Scenario: Agent invocation row without its creating record

- **WHEN** the move finds an active Agent invocation row with no parent
  turn id and request record id (a row from before step 3), or a row whose
  actor differs from that record
- **THEN** it closes the row with a `failed` result to the parent, and it
  never looks up the parent's latest invocation for an actor (I15).

#### Scenario: Inbox move after a crash

- **WHEN** a worker dies inside the move and the next new-core take runs
  it again
- **THEN** each moved input has one request record, unique on
  `(conversationId, inboundMessageId)`, and a Slack retry of a moved
  message is a duplicate.

#### Scenario: Moved authority not verified

- **WHEN** a moved turn or record has no actor, or its old subject fails
  today's check
- **THEN** the move closes it with a visible note and fills in no actor
  from another source (I15).

#### Scenario: Repair job moves leftover state

- **WHEN** an idle old-core conversation still holds today's state and gets
  no new input
- **THEN** the repair job moves it through a full new-core lock take (the
  compare-and-set, the stale lease fence, the pin and the authority
  checks), never moves a child before its root has `core = new`, and
  notifies the parent of each active Agent invocation row left on an
  old-core conversation.

#### Scenario: Delete release blocked while old state remains

- **WHEN** the delete release deploys before the repair job has saved
  `oldStateDrainedAtMs`, or while an active Agent invocation row is on an
  old-core conversation
- **THEN** its guard migration fails, CI/CD stops the deploy, and the next
  deploy checks again.

#### Scenario: Column drop blocked while older code is live

- **WHEN** the release that drops the `core`, `execution_status` and
  `run_id` columns deploys while a deployment row without
  `old_core_deleted` has `lastSeenAtMs` within
  `1 h + 2×maxDuration + 2 min + 60 s`
- **THEN** its migration fails before it drops anything, and CI/CD stops
  the deploy.

#### Scenario: Revert and promote within one cron interval

- **WHEN** a release from step 15 is current for less than one cron
  interval, then the step 16 release is promoted again
- **THEN** the step 15 invocations in that window write their deployment
  row's `lastSeenAtMs`, and the column-drop guard waits from that time.

#### Scenario: Instant Rollback below step 3

- **WHEN** an Instant Rollback makes a release from before step 3 current
- **THEN** within 3 minutes the current row's `updatedAtMs` is too old,
  every new-core worker takes no lock and acks, pinned conversations wait
  until a roll forward, and no guard migration runs. A new-core
  invocation that read the row before then can still pin until its
  `maxDuration` ends, so the accepted window is 3 minutes plus one
  invocation.

#### Scenario: Short rollback below step 3

- **WHEN** an Instant Rollback below step 3 is current for less than 3
  minutes, so the current row misses one cron run, and then a roll
  forward makes a step 15 release current
- **THEN** the first upsert after the roll forward sets `freshSinceAtMs`,
  and for 1,860 s a move that finds no lease and no tombstone waits (C13).

#### Scenario: Abandoned half-moved turn

- **WHEN** a move crashed after its insert, `abandonTurnRecord` then ended
  the Redis cursor, and a new-core take repeats the move
- **THEN** the repeat ends the open turn row through `finishTurn` with the
  same end status, deletes the cursor, and does not run the turn.

#### Scenario: Pending stop moves with the conversation

- **WHEN** the move finds today's stop request for a conversation
- **THEN** it sets `stopAtMs` so that the inputs in the stop's
  `inboundMessageIds` are under the stop and later inputs are not.

#### Scenario: Quiet new-core conversation keeps its pin

- **WHEN** a `core = new` conversation gets no lock take for 7 days
- **THEN** the repair sweep has refreshed its record's TTL, so the pin is
  still there.

### Requirement: Stale Lease Fence

The move SHALL take an expired today's lease only after the later of
`acquiredAtMs + D(lease)` and
`staleLeaseAcquiredAtMs + staleLeaseMaxDurationSeconds`, plus 60 s (Decided:
P45). Until then it SHALL set `wakeAtMs` to that time. A heartbeat clear or a
take over an expired lease SHALL first save the old `acquiredAtMs` as
`staleLeaseAcquiredAtMs`.

#### Scenario: Expired lease waits out the old worker

- **WHEN** the move finds today's lease expired, and less than
  `maxDuration` plus 60 s has passed since its `acquiredAtMs`
- **THEN** it does not take the lease, and it sets `wakeAtMs` to that
  time.

#### Scenario: Cleared lease waits out the old worker

- **WHEN** the heartbeat cleared an expired lease, or another worker took
  over and released it, less than `maxDuration` plus 60 s after the first
  holder's `acquiredAtMs`
- **THEN** the move waits until `staleLeaseAcquiredAtMs` plus
  `maxDuration` plus 60 s, though the conversation has no lease.

### Requirement: Fence Duration

`D(lease)` SHALL be `maxDurationMaxSeconds`, the running max over every
deployment since step 3, for a lease with a `deploymentId`, else the 1,800 s
platform ceiling (Decided: P45).

#### Scenario: Lease from before step 3

- **WHEN** the move finds an expired lease with no `deploymentId`
- **THEN** it waits until 1,800 s plus 60 s after its `acquiredAtMs`.

### Requirement: Fence Read Order

The move SHALL read today's lease first and `staleLeaseAcquiredAtMs` after
it, in the conversation mutation that writes the pin (Decided: P45, C11).

#### Scenario: Tombstone read after the lease

- **WHEN** a heartbeat clear saves `staleLeaseAcquiredAtMs` and erases the
  lease while a move runs
- **THEN** the move, which reads the tombstone after the lease, sees either
  the lease or the new tombstone, and waits out the old worker.

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
  stops repeats (Decided: P10, P11).

### Requirement: A Turn Must Make Progress

A turn that pauses `soft_time_limit` at the boundary it resumed from SHALL
end `failed: no_progress`. A `post_retry` pause SHALL be exempt until its
delivery reaches 5 post attempts; then the turn SHALL end
`failed: post_failed` (Decided: P11).

#### Scenario: Same boundary twice

- **WHEN** a resumed attempt pauses `soft_time_limit` at the boundary it
  resumed from
- **THEN** the turn ends `failed: no_progress` with a visible error message.

### Requirement: Per-Turn Limits

A turn SHALL stop at 100 attempts, 1,000 tool calls or $100 cost. Totals
SHALL survive resume, compaction and handoff. A limit SHALL end the turn on
the first try after one wrap-up step, outside the retry limit (Decided: P12).

#### Scenario: Cost limit

- **WHEN** a step goes over the cost limit
- **THEN** that step gets a wrap-up instruction, and the turn ends
  `failed: limit` without a retry.

### Requirement: Retry Limit Per Turn

A turn SHALL have one retry limit (Decided). An error after take-in SHALL
pause the turn `error_retry`, count one error, and release the lock
(Decided: P31). A lost-worker restart SHALL also count one error. The limit
SHALL be 5 errors, restarts included; one failure SHALL count once
(Decided: P4).

#### Scenario: Retries run out

- **WHEN** a turn's fifth error happens
- **THEN** `finishTurn` ends it `failed`, the error message goes to its reply
  targets, and other people's waiting input stays.

#### Scenario: An error is not a lost worker

- **WHEN** an attempt fails with an error and releases the lock
- **THEN** the next worker resumes the `error_retry` pause, counts no second
  error, and does not use the restart.

### Requirement: Errors Before The Input Is Saved

An error before `startTurn` commits SHALL retry the message with no visible
text and count one delivery attempt. Each message SHALL allow 5 delivery
attempts. After the fifth, a closing turn SHALL end `failed: input_dropped`
and send the error message. These attempts SHALL NOT count against the
turn error limit, because no turn started (Decided: P22).

#### Scenario: Failures before the turn started

- **WHEN** a message fails 4 times before `startTurn` commits, and then its
  turn starts
- **THEN** nothing showed for the 4 failures, and the turn starts with
  `errors: 0`.

### Requirement: Lost Worker Gets One Restart

After a lost worker, every kind of turn SHALL get one restart from its last
checkpoint (Decided). A turn SHALL count as lost only when it is `running`
and the worker took an expired lock (Decided: P8). The restart SHALL count
one error against the retry limit. `restarts` SHALL only enforce the one
restart (Decided: P4).

#### Scenario: Lost twice

- **WHEN** the worker is lost again after the restart, or the restart would
  be the fifth error
- **THEN** the turn ends `failed: lost_worker` with a visible error message.

#### Scenario: Pause save fails

- **WHEN** a worker's pause save fails while the turn is `running`
- **THEN** it does not release the lock, the lock expires, and the repair
  job notifies a worker on its next pass (Decided: P8).

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
be `failed`, and the turn SHALL finish anyway (Decided:
P33).

#### Scenario: Error message cannot be posted

- **WHEN** the error message fails 5 times
- **THEN** the turn ends `failed`, its record is `answered`, and
  `turn.terminal` says the delivery failed.

### Requirement: Closing Turns

Input that will not run SHALL still get a turn row that ends at once,
without the agent (Decided: P30).

#### Scenario: Input past its delivery attempts

- **WHEN** a message reaches 5 delivery attempts
- **THEN** a closing turn ends `failed: input_dropped` and sends the error
  message.

### Requirement: One Repair Job

One repair job SHALL resend lost input, stamp records on `accepted`,
`duplicate` or `refused`, stop after 5 attempts or 24 h, and notify workers
for flagged records, past wake times (from a wake-time index) and
`running` turns whose lock expired. It SHALL write no status (Decided: P7).

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
