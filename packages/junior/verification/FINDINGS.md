# Findings Against 5356776

Each finding names its check. CI checks are in `checks.txt`; evidence
checks (drafts and failing variants) are in `evidence.txt`
(`CHECKS=evidence.txt ./check.sh`). A violated check's trace is in
`.out/<instance>.<property>.log`; `trace.py` prints it one step per line.
A trace of N steps has N + 1 states. TLC searches breadth-first, so each
safety trace is a shortest one within its bounds. Line numbers are in
`openspec/changes/shared-conversation-core/design.md` at the revision
that each section names.

## P45 Shim (5356776)

Models: `CutoverShim.tla` (the fence, the tombstone, the pin, the move,
the move back; from 5356776 also the rollback below step 3, mixed
`maxDuration`, the pending stop, I15, the pin expiry and Slack ingress),
`CutoverTree.tla` (a parent and a child under the shim) and
`DropGuard.tla` (the column-drop guard). Line numbers in this section
are at `5356776`.

| Check                                           | Result           | States | Plan                                |
| ----------------------------------------------- | ---------------- | ------ | ----------------------------------- |
| `tree_shim` resultNotLost, resultOneOwner       | holds            | 1.08M  | C7 in the shim's terms, `:988-1006` |
| `tree_shimNoFence` resultNotLost                | fails, 6 steps   | 6K     | without the child's fence           |
| `tree_shimNoPin` resultNotLost                  | fails, 5 steps   | 2K     | without the child's pin             |
| `tree_shimEarlyTomb` resultNotLost              | fails, 8 steps   | 16K    | C11 order broken for the child      |
| `shim_design` safety, oneCore                   | holds            | 4.22M  | the fence, the pin, C10, C12, C14   |
| `shim_abandon` safety                           | holds            | 5.29M  | `:946-949`                          |
| `shim_ingress` safety and ingress               | holds            | 10.4M  | C5, C6 claim, `:966-986`            |
| `shim_ingressNoClaim` acceptedOnce              | fails, 3 steps   | 114    | today's ingress without the claim   |
| `shim_ingressNoClaim` noDuplicateTurn           | fails, 10 steps  | 106K   | C5                                  |
| `shim_ingressNoClaim` retryAfterMoveIsDuplicate | fails, 10 steps  | 302K   | C6                                  |
| `shim_ingressRevNoFence` oneCoreLive            | fails, 11 steps  | 90K    | C14: `:1112-1123`                   |
| `shim_abandonPlan` noSupersededRun              | fails, 13 steps  | 560K   | C12: `:1112-1119`                   |
| `shim_abandonNoEnd` noSupersededRun             | fails, 14 steps  | 876K   | C12 without the end rule            |
| `shim_gap` noDuplicateTurn                      | fails, 16 steps  | 1.55M  | the give-up (170f513 `:1061-1065`)  |
| `shim_gap` safety                               | fails, 9 steps   | 32K    | same (`noOldWriteAfterPin`)         |
| `shim_plan` safety, noDuplicateTurn             | fails, 19 steps  | 2.69M  | C10 (170f513)                       |
| `shim_noFence` noDuplicateTurn                  | fails, 13 steps  | 297K   | without the fence                   |
| `shim_earlyTomb` noDuplicateTurn                | fails, 15 steps  | 737K   | C11                                 |
| `shim_rollback` onlyWindowGap                   | holds            | 56.0M  | C13 fix, `:1222-1227`               |
| `shim_rollback` safety                          | fails, 8 steps   | 8K     | the accepted window                 |
| `shim_rollbackStale` onlyWindowGap              | fails, 9 steps   | 19K    | C13: `:1084-1086`                   |
| `shim_rollbackNoFresh` onlyWindowGap            | fails, 9 steps   | 19K    | no `freshSinceAtMs`                 |
| `shim_rollbackNoStale` onlyWindowGap            | fails, 10 steps  | 62K    | a stale row stays current           |
| `shim_rollbackNoRefresh` onlyWindowGap          | holds            | 64.8M  | no TTL refresh, `:935-938`          |
| `shim_long` safety                              | holds            | 22.8M  | `D(lease)`, the ceiling             |
| `shim_longCurrent` noDuplicateTurn              | fails, 14 steps  | 862K   | `D(lease)` of the current deploy    |
| `shim_longNoCeiling` noDuplicateTurn            | fails, 14 steps  | 1.70M  | no ceiling for no `deploymentId`    |
| `shim_stop` safety                              | holds            | 3.97M  | the pending stop                    |
| `shim_stopNoMove` stopHonored                   | fails, 9 steps   | 27K    | the move drops the stop key         |
| `shim_inv` safety                               | holds            | 3.57M  | I15                                 |
| `shim_invCopy` movedActorVerified               | fails, 5 steps   | 1K     | trusts the stored actor             |
| `drop_design` noReadAfterDrop                   | holds            | 79.8M  | `:1192-1209`                        |
| `drop_spare` noReadAfterDrop                    | holds            | 4.20M  | `+2 min 15 s`, no revert            |
| `drop_noSpare` noReadAfterDrop                  | fails, 284 steps | 4.20M  | `+2 min`, no revert                 |
| `drop_oneMax` noReadAfterDrop                   | fails, 268 steps | 4.20M  | one `maxDuration`                   |

`safety` is `oneCoreLive`, `noDuplicateTurn`, `noStrandedCursor`,
`moveIdempotent`, `noTurnOpenedAfterMove`, `noOldWriteAfterPin`,
`noSupersededRun`, `stopHonored` and `movedActorVerified`.
`onlyWindowGap`: `safety` and `oneCore` hold, or a new-core invocation
that read the current row before it was 3 cron runs old pinned while the
rollback was current (the accepted window, `:1222-1227`).

### C7 in the shim's terms (`:988-1006`)

`tree_shim` holds `resultNotLost` and `resultOneOwner`: a step 3 child
worker `co` and one from before step 3, `cp` (no `core` read, no
tombstone, takes only an absent lease); each can stall or crash, and no
result write checks a token. The row moves only after the child's lease
and tombstone pass the stale lease fence, read in one step after the
lease (C11), and the move pins the child. Each part is needed:

- `tree_shimNoFence`, 6 steps: `cp` takes the child lease and stalls; the
  move takes the row at once; `cp` writes its result to the moved row.
- `tree_shimNoPin`, 5 steps: the move finds no child lease and does not
  pin; `cp` takes the lease after the move and writes its result.
- `tree_shimEarlyTomb`, 8 steps: the move reads the child's tombstone
  (none); `cp` stalls, and the heartbeat saves the tombstone and clears
  the lease; the move sees no lease and uses the tombstone it read.

`tree_fenced` (core-model's result-token check against the deploy gate)
is evidence only.

### C5, C6 under the fence (`:966-986`)

`shim_ingress` holds `safety`, `noDuplicateTurn`, `acceptedOnce`,
`retryAfterMoveIsDuplicate` and `noLostInput` with the shared claim.
Slack delivers i3 and retries i1 and i3. Without the claim
(`shim_ingressNoClaim`):

- `acceptedOnce`, 3 steps: a retry of i1 after the lock take sets
  `core = new` and before the move copies `inboundMessageIds`.
- `noDuplicateTurn`, 10 steps (C5): the retry of i1 goes to the new
  core's inbox after the pin; a take on a revert runs it, so T1 starts
  twice.
- `retryAfterMoveIsDuplicate`, 10 steps (C6): today's path reads
  `core = old`, the move runs, the append lands, and a retry of i3 is new.

`cutover_inboxShared` (the claim against the deploy gate) is evidence
only. With the claim, an append after the move stays in `pendingMessages`
until the next new-core take moves it. Inference: the step 15 sweep or
the next message brings that take; the model checks no liveness for it.

### C12. The move back runs an abandoned half-moved turn

`shim_abandonPlan noSupersededRun`, 13 steps: `n` inserts T1's turn row
and crashes before the Redis delete. A revert makes a release without
`new_core` current. `abandonTurnRecord` ends T1's cursor as `abandoned`.
The revert's lock take finds `core = new` and runs `work()`, which runs
T1's open row. The plan's move back runs `work()` first and the C10
delete after (`:1112-1119`, 14.2); only a new-core take ends such a row
(`:946-949`, 15.2). Fix (modeled, `CLEANFIRST`): the move back runs the
C10 delete with the same rule (an open row of an ended cursor gets that
end through `finishTurn`) before `work()`. `shim_abandonNoEnd` (14
steps) is the same run with the delete but without the end rule.

### C13. A rollback shorter than 3 minutes sets no freshSinceAtMs

`shim_rollbackStale onlyWindowGap`, 9 steps:

1. `o1` takes today's lease. A new-core invocation `n` starts and reads
   the current row.
2. An Instant Rollback below step 3. `n` takes the SQL lock
   (`core = new`). `o1` stalls; the rollback's heartbeat clears the lease
   and saves no tombstone (`:917-920`).
3. A roll forward within 3 minutes. The row missed one cron run, so
   `freshSinceAtMs` stays (`:1084-1086`).
4. `n` finds no lease and no tombstone and pins at once. `o1` still runs
   and takes i2 after the pin.

The window in the plan (`:1222-1227`) ends at the roll forward; this run
is after it. Fix (modeled, `FRESH = "any"`): set `freshSinceAtMs` when
the old `updatedAtMs` is more than one cron interval (plus jitter) old.
A clear by the rollback's heartbeat misses at least one upsert.
`shim_rollback` holds `onlyWindowGap` with it. Also:

- `shim_rollbackNoFresh` (9 steps) and `shim_rollbackNoStale`
  (10 steps: a row 3 runs old stays current) fail.
- The window is 3 minutes plus one invocation: `ex_pinAfterStale` is a
  pin by an `n` that read the row in the window, after the row went
  stale. The plan's "up to 3 minutes" leaves out up to one
  `maxDuration`.
- With the daily refresh, a pin expires only while the rollback is
  current and the row is stale (`ex_pinExpired`). Without it
  (`shim_rollbackNoRefresh`), `onlyWindowGap` still holds: a new-core
  take that finds no pin passes the fence and pins again, and while the
  rollback is current that pin is in the window. Inference: the refresh
  keeps a quiet conversation pinned, so code from before step 3 does not
  run new input on today's core while its moved turns wait
  (`:1140-1146`). No check here covers that split.

### C14. A take on the revert runs work() with no fence

`shim_ingressRevNoFence oneCoreLive`, 11 steps: `o1` holds today's
lease and runs T1. `n` takes the SQL lock (`core = new`), finds the live
lease and waits. A revert makes a release without `new_core` current.
Slack delivers i3; `core = new`, so it goes to the new core's inbox. The
revert's lock take finds `core = new` and runs i3 with `work()` while
`o1` runs T1. No move ran, so nothing pinned today's lease, and the move
back (`:1112-1119`, 14.2) has no fence. Fix (modeled, `REVFENCE`): a
take on a release without `new_core` that finds `core = new` and no pin
first passes the stale lease fence and pins (C11 order), then runs
`work()`. The move back gives today's state back when it clears the pin.
Inference: only a release from step 14 runs `work()` (`:1120-1123`), so
the fix is needed from step 14.

### Mixed maxDuration, the pending stop, I15

- `shim_long` (both today's workers on a deployment with the longer
  `maxDuration`) holds `safety`. `shim_longCurrent` (`D(lease)` is the
  current deployment's value) and `shim_longNoCeiling` (a lease with no
  `deploymentId` gets the running max) fail `noDuplicateTurn`, 14 steps
  each: the fence passes on the short value, and a stalled long worker
  takes i2 after the pin.
- `shim_stop` holds `safety`. `shim_stopNoMove stopHonored`, 9 steps:
  the move drops today's stop key, and the new core runs a stopped turn.
- `shim_inv` (an Agent invocation row with the creating turn and actor,
  one with another actor, one whose parent turn is gone, one with no
  parent turn id) holds `safety`. `shim_invCopy movedActorVerified`, 5
  steps: a move that trusts the stored actor moves a row for actor B.

### Column-drop guard (`:1192-1209`)

`DropGuard.tla` checks that no step 15 invocation runs at the drop. A
step 15 invocation that works (ingress, or a delivery while the row
names step 15) first upserts `lastSeenAtMs`, at most once a minute. A
delivery that finds the row naming step 16 acks with no upsert. A revert
and a promote again can fall within one cron interval. `drop_design`
(`1 h + 2×maxDuration + 3 min`) holds. With no revert, the model holds
at `+2 min 15 s` (`drop_spare`) and fails at `+2 min` (`drop_noSpare`,
284 steps): the 60 s throttle adds one minute to the earlier `+60 s`
bound. `drop_oneMax` (one `maxDuration`) fails in 268 steps. The model
rounds each bound up by at most 15 s, so the 3 min wait has 45 s to 60 s
of spare. Not modeled: a revert in progress at the drop that no
invocation has reached. No guard can see it; it is the Instant Rollback
after step 17 that `:1132-1137` rules out.

## P45 Shim (170f513)

The first shim checks. Line numbers in this section are at `170f513`.
The results are in the table above.

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
is the plan's "after it they find no cursor". `ex_abandonedHalfMoved`:
`n` crashes between the insert and the delete, so the cursor lock is
free; `abandonTurnRecord` writes `abandoned` on a cursor that already
has a turn row. At `170f513` the repeat deleted it and ran the turn;
`5356776` ends that row instead (`shim_abandonNoEnd`, C12 above).

## P45: The Cutover (01e2234 and 90bbd9b)

Models: `Cutover.tla` (one conversation) and `CutoverTree.tla` (a parent
and a child). Line numbers in this section are at `01e2234`. 170f513
replaced the deploy gate (C9) and the delete and drop releases (C8) with
the shim above; `cutover_gated` and `cutover_gatedSeen` are now evidence.
`cutover_inboxShared` and `tree_fenced` left CI at `5356776`:
`shim_ingress` and `tree_shim` check C5, C6 and C7 under the shim.

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
checks the child's lease token too. `tree_fenced` holds. `5356776` does
not adopt it (a child worker from before step 3 has no such check); see
C7 in the shim's terms above.

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
