# Findings Against 170f513

Each finding names its check. CI checks are in `checks.txt`; evidence
checks (drafts and failing variants) are in `evidence.txt`
(`CHECKS=evidence.txt ./check.sh`). A violated check's trace is in
`.out/<instance>.<property>.log`; `trace.py` prints it one step per line.
A trace of N steps has N + 1 states. TLC searches breadth-first, so each
safety trace is a shortest one within its bounds. Line numbers are in
`openspec/changes/shared-conversation-core/design.md` at `170f513`
unless a section names another revision.

## P45 Shim (170f513)

Models: `CutoverShim.tla` (the fence, the tombstone, the pin, the move,
the move back) and `DropGuard.tla` (the column-drop guard).

| Check                               | Result           | States | Plan                             |
| ----------------------------------- | ---------------- | ------ | -------------------------------- |
| `shim_design` safety                | holds            | 4.28M  | `:869-917`, `:990-1019`, C10 fix |
| `shim_design` oneCore               | holds            | 4.28M  | same                             |
| `shim_abandon` safety               | holds            | 4.59M  | `:963-976`                       |
| `shim_gap` noDuplicateTurn          | fails, 16 steps  | 1.50M  | the give-up at `:1061-1065`      |
| `shim_gap` safety                   | fails, 9 steps   | 32K    | same (`noOldWriteAfterPin`)      |
| `shim_plan` safety, noDuplicateTurn | fails, 19 steps  | 2.4M   | C10: `:916-917`, `:1006-1014`    |
| `shim_noFence` noDuplicateTurn      | fails, 13 steps  | 286K   | the fence at `:877-882` removed  |
| `shim_earlyTomb` noDuplicateTurn    | fails, 15 steps  | 785K   | C11: read order, `:877-898`      |
| `drop_design` noReadAfterDrop       | holds            | 4.03M  | `:1042-1052`                     |
| `drop_oneMax` noReadAfterDrop       | fails, 268 ticks | 4.02M  | one `maxDuration` instead of two |

`safety` is `oneCoreLive`, `noDuplicateTurn`, `noStrandedCursor`,
`moveIdempotent`, `noTurnOpenedAfterMove` and `noOldWriteAfterPin`.

Model rules (`CutoverShim.tla`):

- Each invocation ends at `maxDuration` and makes no write after it. Each
  today's lease take mints a fresh token and the next epoch
  (`acquiredAtMs`). `Tick` is "acquiredAt of the next epoch plus
  `maxDuration` plus 60 s has passed": it ends every invocation that
  started before that take (`born`). The fence passes for a lease or a
  tombstone when its epoch is at most `fence`.
- The move (`NLease`) reads the lease and `staleLeaseAcquiredAtMs`
  (`tomb`) and writes the pin in one step, in the conversation mutation
  that every today's lease take uses (`startConversationWork`,
  `task-execution/state.ts:1540-1588`). A live lease, or
  `max(acquiredAt, tomb)` not past the fence: it sets `wakeAtMs` and
  ends. No lease and `tomb` past the fence: it moves at once.
- From step 3, the heartbeat clear (`HeartbeatClear`) and a take over an
  expired lease save `tomb = max(tomb, acquiredAt)` first. `p` (before
  step 3) saves nothing and has no reader. In `shim_design` it takes only
  an absent lease; `shim_gap` lets it take over an expired lease.
- Today's workers have no cursor-write lease check (C3 not chosen,
  `:1084-1085`). A worker can release with work left (a continuation,
  `worker.ts:418-423`); the next delivery takes a new lease. Deliveries
  can start a today's worker at any time, so pinned deliveries and
  busy-defer chains are in every run.
- The move holds `withTurnCursorMutation` for each open cursor from the
  insert to the Redis delete; a crash frees it. Today's cursor writes and
  `abandonTurnRecord` take the same lock. `abandonTurnRecord` writes only
  the end status, and nothing when the cursor is gone.
- The cron sets the current row (`Flip`). `n` on a deployment that is
  not current takes no lock. On the revert it runs `work()` on a
  `core = new` conversation, then moves it back.
- `noDuplicateTurn` skips an input that today's path wrote without the
  lease before any pin (today's bug), and does not count two of today's
  workers finishing one turn; after the pin, `noOldWriteAfterPin` catches
  the second write.

### The give-up: a takeover from before step 3 (`:1061-1065`)

`shim_gap noDuplicateTurn`, 16 steps:

1. `o1` (step 3) takes today's lease (epoch 1) and runs T1 to its end.
2. `n` takes the SQL lock and sets `core = new`.
3. `o1` stalls; its lease expires. `o1` still runs.
4. `p` (before step 3) takes over the expired lease (epoch 2). It saves
   no `staleLeaseAcquiredAtMs`, then hands off to a continuation and
   releases. No lease and no tombstone are left.
5. `n` moves at once: it pins and inserts the inbox entry for i2.
6. `o1` takes i2 from `pendingMessages` (a write after the pin).
7. `n` deletes and clears, then runs i2 from its inbox entry. i2 starts
   twice.

`shim_gap safety` fails in 9 steps: step 6 comes right after the pin
(`noOldWriteAfterPin`). `shim_gap` differs from `shim_design` only in
that takeover, and `shim_design` holds every check.

### C10. The move back after a crashed move runs today's state again

`shim_plan safety` (and `noDuplicateTurn`), 19 steps:

1. `n` sets `core = new`, pins, and inserts the turn row for T1 and the
   inbox entry for i2 (`:911-917`).
2. `n` crashes before the Redis delete. T1's cursor and i2 in
   `pendingMessages` stay.
3. A revert makes a release without `new_core` current (`:1015-1019`).
   Its lock take finds `core = new`, runs T1 and i2 with `work()`, then
   sets `core = old` and clears the pin (`:1006-1011`).
4. `p` takes today's lease and takes i2 from `pendingMessages`. i2 starts
   twice. (Inference, not the trace: T1's open cursor can run again the
   same way.)

Only a new-core take repeats the move (`:916-917`), and the reverted
release has no move. Fix (modeled, `FINISHBACK`): before it sets
`core = old`, the move back runs the repeat's Redis part: it deletes each
cursor that has a turn row and each waiting input that has a request
record. Every release from step 3 needs it, because each one is a revert
target (`:993-994`). `shim_design` and `shim_abandon` hold with it.

### C11. The move must read the tombstone after the lease

`shim_earlyTomb noDuplicateTurn`, 15 steps: `n` reads
`staleLeaseAcquiredAtMs` (none) from SQL before it reads today's lease.
`o1` holds the lease and runs; it stalls, and the heartbeat saves the
tombstone and clears the lease. `n` then finds no lease and uses the
tombstone it read before: it moves at once, and `o1` and `n` both start
i2. The plan does not set the order (`:877-882`). Fix (modeled in
`shim_design`): read the tombstone after the lease, in the conversation
mutation that writes the pin. Both paths save the tombstone before they
erase the lease (`:895-898`), so a lease that is gone then has its
tombstone.

### The fence alone

`shim_noFence noDuplicateTurn`, 13 steps: `o1` stalls, its lease
expires, `n` pins at once, `o1` takes i2 from `pendingMessages`, and both
start i2. With the fence, `shim_design` holds `oneCore` too: no today's
worker runs at all while `n` runs, stalled or not.

### Lease-less writes (`:963-976`)

`shim_abandon safety` holds: `abandonTurnRecord` never opens a turn after
the move (`noTurnOpenedAfterMove`). `ex_abandonFoundNoCursor` (9 steps)
is the plan's "after it they find no cursor". `ex_abandonedHalfMoved` (8
steps): `n` crashes between the insert and the delete, so the cursor
lock is free; `abandonTurnRecord` writes `abandoned` on a cursor that
already has a turn row. The repeat deletes it and `n` runs the turn. That
is the same outcome as an abandon after the move, which the plan
accepts.

### Column-drop guard (`:1042-1052`)

`DropGuard.tla` checks that no step 15 invocation runs at the drop.
`drop_design` (the 1 h + 2 `maxDuration` + 2 min wait) holds.
`drop_oneMax` (1 h + one `maxDuration` + 2 min) fails: a step 15
invocation that started just before the cron saw the new row sends a
message near its `maxDuration`; the message is delivered just before its
1 h retention ends, and that delivery runs for one more `maxDuration`.
The model holds with a wait down to 1 h + 2 `maxDuration` + 75 s and
fails at 1 h + 2 `maxDuration` + 60 s (`drop_noSpare`, the skew alone).
It rounds each bound up by at most 15 s, so it is stricter than the
host, where the last step 15 read is before `currentSinceAtMs` + 1 h + 2
`maxDuration` and the skew can move the check 60 s early. The 2 min wait
has 45 s to 60 s of spare.

Not modeled: an Instant Rollback to step 15 and a promote again (a
draft with them passed 30M states without an end).
Inference: the rollback makes the row name step 15, so the guard fails
until the next promote, which sets `currentSinceAtMs` again; from there
the run is `drop_design`'s.

Plan text: `:1045` says "under 2 h for any `maxDuration` up to 1,740 s".
With 1,740 s the wait is 3,600 + 3,480 + 120 = 7,200 s, exactly 2 h.

## P45: The Cutover (01e2234 and 90bbd9b)

Models: `Cutover.tla` (one conversation) and `CutoverTree.tla` (a parent
and a child). Line numbers in this section are at `01e2234`. 170f513
replaced the deploy gate (C9) and the delete and drop releases (C8) with
the shim above; `cutover_gated` and `cutover_gatedSeen` are now evidence.
C5, C6 (`cutover_inboxShared`) and C7 (`tree_fenced`) stay in CI.

| Check                                                       | Result | Plan                         |
| ----------------------------------------------------------- | ------ | ---------------------------- |
| `cutover_gated` safety, noDuplicateTurn                     | holds  | P45 with the C8 and C9 fixes |
| `cutover_gated` sweepMoves (fairness: repair job, time)     | holds  | background sweep (`:962`)    |
| `cutover_gatedSeen` noDuplicateTurn                         | fails  | C9: the gate at `:869-885`   |
| `cutover_inbox` (the inbox move as written)                 | fails  | C5, C6                       |
| `cutover_inboxShared` safety, noDuplicateTurn, acceptedOnce | holds  | fixes for C5, C6, C8         |
| `cutover_inboxShared` noOldStateAfterDelete                 | fails  | C8: the guard at `:996-1002` |
| `tree_plan` resultNotLost                                   | fails  | C7                           |
| `tree_fenced` resultNotLost, resultOneOwner                 | holds  | fix for C7                   |

Model rules:

- No operator switch (P47). The gate is on while a new-core deployment is
  live and the deploy marker is aged (`SwitchOn`). `Deploy` is a deploy
  or a revert deploy (3 per run). A revert turns the gate off. The
  reverted new core still gets its own queue deliveries, so `n` can still
  take a new-core conversation.
- Vercel push mode sends a queue message back to the deployment that
  published it, until it is acked or expires (24 h by default, up to 7
  days). `o1` keeps a bag of its own pending deliveries (`o1Queue`, at
  most 1). Each one can start an `o1` attempt at any later time.
- `o1` has no fence (`OldOk`). It takes no new request after the marker
  (`Mark`), only its own deliveries. The 5-minute attempt limit ends an
  attempt in flight (`AttemptLimit`).
- The repair job sweep starts `n` on a conversation with today's state.
  `sweepMoves` uses `SpecFairSweep`: weak fairness for `n`'s steps, strong
  fairness for its wait on today's lease, and time (a dead holder's lease
  expires, `o2`'s attempt ends). No fairness for Slack, deploys or `o2`
  taking new work.
- `noDuplicateTurn` and `noCrossCoreDuplicate` skip an input that `o1`
  wrote after its lease expired on an old-core conversation (`o1Stale`).
  Today's path runs that turn twice too. They still count every other
  input.
- Slack ingress with `core = new` is one SQL insert that checks `core` in
  the same transaction. With `core = old` it reads `core`, then writes
  Redis.
- `cutover_inboxShared` has no `o1`: the gate keeps `o1` out of each run
  with the gate on, and before that every step is today's behavior.

### C9. The 6.5-minute gate does not prove o1 is gone

`cutover_gatedSeen noDuplicateTurn` (and `noCrossCoreDuplicate`), 16
steps:

1. `o1` publishes a queue message. The marker is written and is 6.5
   minutes old with no `o1` check-in (`:877-885`). The gate opens.
2. `n` takes the SQL lock, sets `core = new` and waits for today's lease.
3. The queue sends `o1` its own message. `o1` takes today's lease (it does
   not read `core`), runs T1, finishes it, and stalls. Its lease expires.
4. `n` pins the lease and inserts the inbox entry for i2.
5. `o1` (no fence) takes i2 from `pendingMessages`.
6. `n` clears, then runs i2 from its inbox entry. i2 runs twice.

`oneCoreLive` holds (8.6M states): `o1` runs only after its lease
expired, the P5 "Limit" window. A check-in that reopens the gate does not
help: `n` passed the gate before `o1` came back.

Fix (modeled, `GATE = "retention"`): a deployment without `reader` counts
as gone only when it has no attempt in flight and its last publish is
older than the queue's maximum retention, so no delivery of it is left.
Inference, not checked: `o1` publishes only while it is current or in an
attempt, so `lastSeenAtMs` plus the maximum retention (7 days unless the
topics set less) plus 6.5 minutes is such a bound, if ingress also
refreshes `lastSeenAtMs`. `cutover_gated` (with `o1Queue`) holds `safety`
and `noDuplicateTurn` (561,227 states) and `sweepMoves`.

### C8. The delete guard misses ingress in flight

`cutover_inboxShared noOldStateAfterDelete`, 10 steps:

1. Slack delivers i3. The ingress adds it to `inboundMessageIds` and reads
   `core = old`.
2. The new core deploys. `n` moves T1 and i2 and clears. No today's state
   is left.
3. The delete release ships (the guard finds no today's state).
4. The ingress appends i3 to `pendingMessages`. No path reads it again,
   and a Slack retry of i3 is a duplicate. i3 is lost.

The guard at `:996-1002` reads the state once (`oldStateDrainedAtMs`).
"No live deployment lacks `new_core`" does not help: the cutover release
has `new_core` and today's ingress. Fix (modeled): the delete release
keeps the move and the sweep. The release that removes them ships only
after the delete release is the only deployment for 6.5 minutes (no
ingress between its `core` read and its Redis write, no `o2` attempt),
and a new sweep finds no today's state (`DropRelease`).
`noOldStateAfterDrop` is in `safety`: it holds in `cutover_gated` and
`cutover_inboxShared` (8.9M states).

### C1 to C4 (drafts, evidence)

- `cutover_design noStrandedCursor`, 4 steps: `n` sets `core = new`,
  then crashes before the move. The open cursor stays.
- `cutover_designNoStall noCrossCoreDuplicate`, 19 steps: `n` inserts the
  rows and entries, deletes the cursor and crashes before it clears
  `pendingMessages`. The next take does not repeat the move. After the
  switch turns off, `o2` moves the conversation back and runs i2 again.
- `cutover_always noCrossCoreDuplicate`, 13 steps: `o2` stalls, its lease
  expires, `n` takes the lease, and `o2` (not fenced) takes i2 from
  `pendingMessages`. Both run i2.
- `cutover_midDeployFenced oneCoreLive`, 12 steps: no pin. `o1` takes the
  lease after the move and runs i3 while `n` runs T1.
- `cutover_midDeployPinnedFenced safety`, 13 steps, no gate: `o1` stalls,
  its lease expires, `n` pins and inserts, `o1` takes i2 from
  `pendingMessages`, and both run i2. C9 is the same run after the gate.

### C5. A Slack retry during the move is a new input

`cutover_inbox noCrossCoreDuplicate`, 10 steps: `n` sets `core = new` and
pins. A Slack retry of T1's message sees `core = new` and no request
record (the move has not copied `inboundMessageIds` yet), so it inserts
an inbox entry. `n` moves and runs T1, then runs the retry. `cutover_inbox
acceptedOnce`, 3 steps, is the same window. Breaks `:917-925`.

### C6. A today's-path append races the move

`cutover_inbox retryAfterMoveIsDuplicate`, 9 steps: the ingress reads
`core = old`; `n` moves; the ingress appends i3; a Slack retry of i3 sees
`core = new` and no record, and is accepted again.
`cutover_inboxBoth noCrossCoreDuplicate`, 19 steps: reading
`inboundMessageIds` in the new-core ingress too is not enough.

Fix for C5 and C6 (`SEEN_CHECK = "shared"`): until the drop release, every
ingress path first adds the id to `execution.inboundMessageIds` (one
atomic Redis add). Only the add that wins goes on. The move promotes a
"seen" record to an inbox entry when that id is in `pendingMessages`.

### C7. A stalled child worker writes its result after the row moved

`CutoverTree tree_plan resultNotLost`, 8 steps: `co` runs the child turn;
the gate opens; `n` pins R's lease; `co` stalls and C's lease expires, so
C looks idle (`:926-931`); `n` moves the invocation row; `co` writes the
result to the moved row. Fix (`RESULT_FENCED`): today's result write
checks the child's lease token too. `tree_fenced` holds.

## P46: A Notify Lost While The Lock Is Held (Decided: Keep The Drop)

`errors_design l3_pausedResumedNoRepair` is a documented limit (expected
to fail), 8 steps then stuttering: the `send()` notify is dropped (lock
held), the worker crashes after the pause save, the redelivered message
is dropped (the dead holder's lock is still live), and the lock expires.
With the repair job, L3 holds (`errors_design` L1, L2, L3, one run). With
no lost notify, L3 holds without the repair job (`wakeLive_design`). The
P46 alternative is not modeled.

## Model Changes

- `send()` runs as its P32 steps with `Crash_AfterRecordInsert`,
  `Crash_AfterAppend`, `Crash_AfterWakeSet` and `Crash_AfterWakeIndex`
  (`SEND_STEPS`, in `lock_design` and `wakeLive_design`). A Slack
  redelivery resumes after the last step done (`ex_sendResumedAfterCrash`).
  The repair job reads the wake-time index, not `wakeAtMs`.
- The notify queue has no cap and no state constraint. Each send comes
  from a bounded event, so the count stays finite (`ex_notifyPileUp`
  reaches 3).
- TLC is pinned to v1.7.4 (SHA-256 in `check.sh`). It has no JSON trace,
  so `trace.py` reads the text trace.

## P4: A Restart Counts As An Error

`errors_design safety` has `errorBudget` and `oneChargePerAttempt`. Both
hold. `errors_rev3 errorBudget` and `errors_noPause oneChargePerAttempt`
(evidence) show the bugs that P4 and P31 fixed.

## Earlier Revisions (evidence)

- `lock_priorDraft`, `errors_priorDraft`, `delivery_priorDraft`: the
  `ab76f5d` bugs that P5, P31 and P33 fixed.
- `wake_rev2`, `wakeLive_rev2`: the `5122bb7` wake loop.
- `wakeLive_rev3 l3_pausedResumedNoRepair`: at `5ed29c2` L3 needed the
  repair job.
- `stop_receive_noJoinFix`: P44 without the join fix.
- Accepted, in CI: `lock_design i3_noStalePost` (P5 "Limit"),
  `lock_design lostTurnPickedUpNoRepair` (P7 part 2),
  `shim_gap noDuplicateTurn` (the P45 give-up).
