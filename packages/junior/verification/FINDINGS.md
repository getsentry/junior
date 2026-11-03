# Findings Against 6c7ab79

Each finding names its check in `checks.txt`. `./check.sh '<filter>'`
writes the trace to `.out/`; `trace.py` prints it. Line numbers are in
`openspec/changes/shared-conversation-core/design.md` at `6c7ab79`.

## P45: The Cutover

Model: `Cutover.tla`. Two of the three requested properties fail on the
plan as written. All three hold with the three fixes below
(`cutover_midDeployPinnedFenced safety`, 2 crashes and 2 expiries).

### C1. A crash after the core switch strands the open turn

`cutover_design noStrandedCursor`, 4 steps, one crash:

1. The switch turns on.
2. `n` takes the lock. The compare-and-set sets `core = new`.
3. `n` crashes before it takes today's lease and moves the state.

The Redis cursor for T1 stays open. `o2` refuses the conversation, and the
next new-core take is not the first one, so it does not move the state.
T1 waits until a rollback. Breaks `design.md:851-857`: "a repeat after a
crash does nothing new" needs a repeat, and only the take that set
`core` moves.

### C2. A crash inside the move runs a turn twice after a rollback

`cutover_designNoStall noCrossCoreDuplicate`, 18 steps, one crash and no
expiry:

1. `n` sets `core = new`, takes the lease and inserts T1's turn row.
2. `n` crashes before it deletes the Redis cursor.
3. The next take runs T1 on the new core to the end (no move: not first).
4. The switch turns off. `o2` finds no open turn row and no open record,
   so it moves the conversation back (`design.md:860-862`).
5. `o2` finds the leftover open cursor and runs T1 again on today's path.

Breaks `design.md:856-857` and `:860-862`.

Fix for C1 and C2 (`MOVE_CHECK = "always"`): every new-core lock take that
finds today's state for the conversation takes the lease and runs the
move. The insert is keyed by turn id, so a repeat inserts nothing new and
only deletes.

### C3. An expired lease is not a stopped old worker

`cutover_always noCrossCoreDuplicate`, 13 steps, one expiry:

1. `o2` takes the lease and runs T1.
2. `n` sets `core = new`. `o2` stalls and its lease expires.
3. `n` takes the lease and inserts T1's row.
4. `o2` still runs. It finishes T1 and writes the cursor `done`.
5. `n` deletes nothing (the cursor is not open), runs T1 and finishes it.

Breaks `design.md:851-852` ("so it waits while an old worker is
mid-turn"). Today's cursor writes take a per-turn mutation lock
(`task-execution/turn-cursor.ts`), not the conversation lease. The model
reads that as "not fenced by the lease"; this is inference from the code.

Fix (`OLD_FENCED`): the reader release makes today's cursor writes check
the lease token. Then `safety` holds. A stalled old worker can still post
until its next check-in (`cutover_oldFenced oneCore`), the same window as
P5 "Limit".

### C4. A worker without the reader release takes the lease after the move

`cutover_midDeployFenced oneCoreLive`, 11 steps, no crash and no expiry:

1. Input i2 arrives. The switch turns on.
2. `n` moves T1: insert the row, delete the cursor, give the lease back.
3. `o1` takes today's lease. It does not read `core`.
4. `o1` starts a turn for i2 on today's path.
5. `n` runs T1 on the new core. The conversation runs on both cores.

Breaks `design.md:848-850`. The rule holds only when every old worker
has the reader release. `tasks.md:17-18` (a writer step starts only after
its reader step is fully deployed) is the only guard, and the cutover
switch does not check it.

Fix (`PIN_LEASE`): the move writes today's lease key with no expiry
before the insert, and leaves it. Only the reader release knows the pin:
`o2` reads `core` without taking the lease, and a move back replaces the
pin. `o1` can never take the lease of a moved conversation. Holds with C1
and C3 fixed.

## P4: A Restart Counts As An Error

`design.md:325-332`. `errors_design safety` has `errorBudget` (at most 1
restart; errors seen plus restarts at most 5) and `oneChargePerAttempt`
(no attempt uses two errors). Both hold. No trace charges one failure
twice: an attempt that saved `error_retry` leaves the turn `paused`, so a
lost worker after it (`Crash_AfterSavePause`) resumes the pause and is not
a restart.

- `errors_design ex_restartUsesLastError`: a lost worker at 4 errors ends
  the turn `failed: lost_worker` instead of a restart (P4: "the fifth is a
  restart").
- `errors_rev3 errorBudget`: at `5ed29c2` a restart did not count, so a
  turn reached 5 errors plus 1 restart.
- `errors_noPause oneChargePerAttempt`, 8 steps: without P31 the error
  save leaves the turn `running` (`errors: 1`). The worker dies right after
  it (`Crash_AfterSaveError`). The next worker takes the turn as lost and
  restarts it (`errors: 2`, `restarts: 1`): one failure used two errors.
  This is the double charge; P31 is what prevents it.

The plan counts a restart in `errors` ("adds 1 to both"). Then the limit
is `errors <= 5`. `restarts + errors <= 5` on those columns would count a
restart twice. The model checks the ghost count `failures` (errors seen
plus restarts) and `errors`, and both stay at most 5.

## L3 Fails Without The Repair Job When A Worker Is Lost After A Pause

`errors_design l3_pausedResumedNoRepair` (new: L3 was checked only on
`wakeLive_*`, which has no losses). Two shortest traces, depending on the
TLC worker order:

- Crash, 12 steps: w1 holds the lock. B's `send()` notify is dropped (the
  lock is live). w1 saves `paused: error_retry` and dies
  (`Crash_AfterSavePause`). The queue delivers w1's message again before
  the dead lock expires, so that notify is dropped too. The lock expires.
  No notify is left.
- Lock expiry, 10 steps: the same, but w1 stalls after its wake
  compare-and-set, fails its check-in, stops and acks its message.

Only the repair job (`design.md:419`, P7 part 2) wakes the turn. Breaks L3
as `specs/verification/spec.md:125-127` states it ("without fairness for
the repair job"). The cause is `design.md:719` ("a notification that
arrives while the lock is held is dropped"): the P32 fix covers a live
holder that releases, not one that dies or loses the lock between its
pause save and its release. With the repair job, L3 holds
(`errors_design l3_pausedResumed`). Options, not modeled: a notify that
finds a live lock is delayed until the lock expires instead of dropped;
or L3 without the repair job is required only for runs with no loss. A
running turn has the same gap (`lostTurnPickedUpNoRepair`, accepted).

## Earlier Revisions

- `lock_priorDraft`, `errors_priorDraft`, `delivery_priorDraft`: the
  `ab76f5d` bugs that P5, P31 and P33 fixed.
- `wake_rev2`, `wakeLive_rev2`: the `5122bb7` wake loop.
- `wakeLive_rev3 l3_pausedResumedNoRepair`: at `5ed29c2` L3 needed the
  repair job; P32 now raises `inboxSeq` on sign-in and queues a delayed
  notify.
- `lock_design i3_noStalePost` and `lostTurnPickedUpNoRepair`: accepted
  (P5 "Limit"; P7 part 2).
