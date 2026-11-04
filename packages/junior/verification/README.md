# Protocol Model

Hand-written TLA+ models of the shared conversation core in
`openspec/changes/shared-conversation-core/` (P37), checked by TLC. They
check the plan at `170f513`. A model change that changes a result also
changes `checks.txt`. `FINDINGS.md` has the counterexamples.

| File              | What it models                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `WorkerLock.tla`  | worker lock, lock version, turn row, errors, deliveries, wake-ups |
| `StopClock.tla`   | the stop time on the Junior receive clock (P34, P44 option 1)     |
| `Cutover.tla`     | the inbox move and Slack ingress at the cutover; the old gate     |
| `CutoverTree.tla` | the cutover of a parent and a child (P45)                         |
| `CutoverShim.tla` | the P45 shim: stale lease fence, tombstone, pin, move back        |
| `DropGuard.tla`   | the P45 column-drop guard (step 17)                               |
| `cfg/`            | one TLC config per instance: the constants of a plan revision     |
| `checks.txt`      | the CI set: design configs and their expected results             |
| `evidence.txt`    | drafts and failing variants (`FINDINGS.md`)                       |
| `check.sh`        | runs the checks with TLC and compares the results                 |
| `trace.py`        | prints a TLC trace from a check log, one line per step            |
| `results.txt`     | the last full run: result, wall time and distinct states          |

## Run

Needs Java 11 or newer. `check.sh` downloads `tla2tools.jar` v1.7.4 (a
stable release; the v1.8.0 prerelease jar was replaced) and checks its
SHA-256, or uses `TLA2TOOLS`. v1.7.4 has no JSON trace, so `trace.py`
reads the text trace in the log.

```sh
./check.sh                       # the CI set, one TLC run at a time
./check.sh '^Cutover'            # one model
CHECKS=evidence.txt ./check.sh   # the evidence list
python3 trace.py .out/cutover_inbox.noCrossCoreDuplicate.log
```

Expected `violated` is a worked example (`ex_*`), accepted behavior
(`acc_*` and the P5 "Limit" checks) or, in `evidence.txt`, a known
counterexample. TLC searches breadth-first, so each safety trace is a
shortest one.

## Instances

`<scenario>_<revision>`. `priorDraft` is `ab76f5d`, `rev2` is `5122bb7`,
`rev3` is `5ed29c2`, `design` is the plan head. `noPause` is `design`
without P31. Cutover instances name the variant they turn on (see
`Cutover.tla`); `cutover_gatedSeen` is `cutover_gated` with the
`01e2234` gate. `shim_design` is P45 at `170f513` with the C10 fix;
`shim_plan` is without it. `shim_gap`, `shim_noFence` and
`shim_earlyTomb` turn on one variant each.

## Bounds

Smaller than the target bound (`design.md`, P37). Each scenario turns on
only what it needs, so TLC explores it exhaustively.

- `WorkerLock`: 1 conversation, 2 workers, 2 inputs, at most 2 losses
  (crashes, sender crashes and lock expiries), 2 post attempts per
  delivery, 5 turn errors (`design`, `rev3`, `noPause`; 2 in
  `priorDraft`). The notify queue has no cap. `send()` runs as its P32
  steps in `lock_design` and `wakeLive_design`; elsewhere it is one step.
  Liveness for wake-ups uses `wakeLive_*`: no losses and no soft pause.
- `StopClock`: 1 person actor, 2 inputs, 1 stop, 2 turns, 6 clock ticks.
- `Cutover`: 1 conversation, one worker of each kind (`o1` without the
  reader release and with no fence, `o2` with it, `n` new core), 3 inputs
  (an open cursor, a waiting input, a new one), up to 4 Slack deliveries,
  2 crashes, 2 lease or lock expiries, 3 deploys or reverts (3 operator
  flips in the drafts), at most 1 pending queue delivery of `o1`, the
  delete and drop releases. `cutover_gated` has `o1` and no deliveries;
  `cutover_inbox*` has the deliveries and no `o1` (the gate retires it
  before it opens).
- `CutoverTree`: 1 parent, 1 child, one worker of each kind on each,
  2 crashes, 2 expiries, the gate opens once.
- `CutoverShim`: 1 conversation, 2 inputs (an open cursor and a waiting
  input), today's workers `o1` (step 3 or later) and `p` (before step 3),
  the new core `n`, 3 today's lease takes (the epoch bound), 2 crashes,
  2 lease or lock expiries, 1 revert. `shim_abandon` has `o1` only and 1
  `abandonTurnRecord` call. Time is the order of lease takes: the fence
  passes epochs one by one (`Tick`), and each pass ends every invocation
  that started before that take. No Slack ingress and no sweep
  (`Cutover.tla` has them).
- `DropGuard`: units of 15 s; `maxDuration` 300 s, retention 1 h, skew
  60 s, a cron run each minute; 2 step 15 invocations, 1 queue message,
  no rollback. Each bound counts
  through the unit it ends in, so the model can be up to 15 s per bound
  more pessimistic than the host.

Not modeled: the system actor, the adversarial `send`, request record
matching (I5, I6, I9, I12), tree stop results (I8), sandbox process tags
(I13), shared sandbox files (accepted, P36), I15 (authority of moved
state) and a Slack retry that finds a request record but no append (the
model resumes `send()` there).

## Crash Points

A `Crash_<Point>` action in `WorkerLock.tla` runs one worker step's
durable write, then the worker dies. The queue delivers its message
again. A `send()` crash stops the sender; Slack delivers again. Each point
is one point of the `faults` port (P42), and the action name names the
write (`Crash_AfterSaveIntent`: the SQL delivery intent). A step with two
writes (an inbox removal of a redelivered prompt and a SQL save in the
same `work()` step) is atomic in the model; its crash point is the SQL
write. `Cutover.tla` and `CutoverShim.tla` let a worker crash at any
step.

## Results

`results.txt`: 63 checks. TLC only, exhaustive within the bounds. No
Apalache and no inductive invariants. Largest: `wake_design` safety, 32.8M
states, 52 minutes. The `errors_design` liveness check (three properties,
one run) takes 2 h. A full run takes about 4 h 20 min on 4 cores.
