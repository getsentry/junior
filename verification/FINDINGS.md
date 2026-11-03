# Findings Against 5ed29c2

Each finding names its check in `checks.txt` and its trace in `traces/`.

## The Stop Time Mixes Clocks (P34)

The stop time is the stop input's `createdAtMs` (source clock). Saves
refuse when it is after the turn's `startedAtMs` (database `now()`). The
two values measure different events on different clocks: when the person
clicked, and when Junior started.

Breaks: `design.md:225-226` (rule 13), `design.md:646-649` (P34),
`interfaces/turn.md:163` and `:249`, and the "Older stop" scenario in
`specs/turn-stop/spec.md:77`. Paths are under `openspec/changes/shared-conversation-core/`.

- `traces/stop_turnBeforeStopKeepsPosting.txt`: no skew. The person sends
  m, then clicks stop. Junior starts the turn after the click, before
  `stop()` saves. `startedAtMs` > `stopAtMs`, so the turn keeps posting.
  Caught by I10. A stop's own ingress time is enough; no skew is needed.
- `traces/stop_stopKillsNewerTurn.txt`: the source clock is ahead of the
  database. `stop()` is saved, then a newer message starts a turn whose
  `startedAtMs` is below `stopAtMs`. The new turn is stopped. No invariant
  in I1–I13 catches it. `spareNewerTurn` does.
- `traces/stop_olderInputJoinsAfterStop.txt`: only `startTurn` checks input
  age. Older input joins a running turn after the stop. Caught by `i11j`.
- `traces/stop_newerJoinedInputStopped.txt`: newer input joins before the
  stop is saved, and the stop ends it as `stopped`. Caught by
  `spareNewerInput`.
- `traces/stop_startingInputRuleNotEnough.txt`: comparing only the
  starting input fails when older input joins a newer turn. Caught by I10.
- `stop_seq_same`: inbox arrival order (`inboxSeq`) has no clock, but fails
  every ground-truth check under delivery lag.

Proposed rule (`stop_proposed_*`, all checks hold, skew 0 and ±3):

1. A turn is under the stop when any input it took in has `createdAtMs`
   older than the stop time. The turn row keeps the oldest `createdAtMs`
   it took in.
2. A join (`saveCheckpoint` with `takeIn`) refuses input older than the
   stop time, like `startTurn`.
3. `finishTurn(stopped)` puts taken-in input that is not older than the
   stop time back in the inbox. Its request record stays `open`.

The rule is exact only when the stop and the input share a clock.
`stop_proposed_crossAhead` and `stop_proposed_crossBehind` show a dashboard
stop on a Slack thread, and a tree stop into a child whose input core
mints, failing. Such a stop needs one clock for both sides: for a child,
the stop transaction's database `now()` if core stamps agent input with it.
P35 compares the parent's stop time with a request record's `createdAtMs`
and has the same risk.

## L3 Needs The Repair Job (P32, P7)

`traces/wake_l3NoRepair_signInDuringLock.txt` (TLC, `wakeLive_design`):
the person signs in while a worker holds the lock. The sign-in notify is
dropped. `recordSignIn` changes neither `inboxSeq` nor `wakeAtMs`, so the
read after the release sees the link expiry and notifies nobody. When the
link expires, only the repair job's wake-time index fires. L3 without
repair fairness fails. Breaks: L3 in `specs/verification/spec.md`,
against `design.md:615-621` (P32), `interfaces/access.md:159` and
`design.md:391` (P7 part 2). This reads "read again" in P32 as a read of the
inbox record; a read that also recomputes `nextRunAtMs` from the SQL turn
row closes the sign-in half, not the expiry half.

Proposed (`wakeLive_proposed`, L3 holds without the repair job):

- `recordSignIn` raises `inboxSeq` and sets `wakeAtMs` to now before it
  notifies, like `send()`.
- The pre-release set of `wakeAtMs` also queues a delayed notify for that
  time, so a link expiry fires without the repair job.

The wake loop of `5122bb7` (`wake_rev2`, `wakeLive_rev2 quiesces`) is gone
at `5ed29c2`: `noWakeLoopWhileBlocked` and `quiesces` hold.

## Other Expected Counterexamples

- `lock_design i3_noStalePost`: a slow worker posts after a takeover. P5
  "Limit" accepts it; I7 and `find` cover the duplicate.
- `lock_design lostTurnPickedUpNoRepair`: a `running` turn whose worker
  died waits for the repair job (P7 part 2). By design.
- `*_priorDraft`: the `ab76f5d` bugs that P5, P31 and P33 fixed.

