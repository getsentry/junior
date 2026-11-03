# Protocol Model

Quint models of the shared conversation core in
`openspec/changes/shared-conversation-core/` (P37, P40). They check the plan
at `5ed29c2`. A model change that changes a result also changes
`checks.txt`.

## Files

| File               | What it models                                                        |
| ------------------ | --------------------------------------------------------------------- |
| `worker_lock.qnt`  | worker lock, lock version, turn row, checkpoints, deliveries, wakes   |
| `stop_clock.qnt`   | the stop time and the clocks it is compared with (P34)                |
| `checks.txt`       | each check and its expected result                                    |
| `check.sh`         | runs the checks with TLC and compares the results                     |
| `trace.py`         | prints a `stop_clock.qnt` ITF trace, one line per step                |
| `traces/`          | counterexample traces (Apalache shortest, or TLC)                     |
| `results.txt`      | the last full TLC run                                                 |

## Run

Needs Quint 0.33 and Java 17 or newer. Quint downloads Apalache.

```sh
./check.sh                 # every check, TLC, one at a time
./check.sh '^stop_clock'   # one model
JOBS=2 ./check.sh          # two TLC processes; more runs out of memory
```

A shortest counterexample (Apalache, bounded):

```sh
quint verify --max-steps 12 --main stop_design_same \
  --invariant i10_noOlderIntentAfterStop --out-itf t.itf.json stop_clock.qnt
python3 trace.py t.itf.json
```

"violated" in `checks.txt` is expected for a known counterexample and for
a worked example (`ex_*`): the example must be reachable.

## Instances

Each instance is `<scenario>_<design>`. `priorDraft` is `ab76f5d`, `rev2`
is `5122bb7`, `design` is `5ed29c2`, `proposed` is `design` plus the fixes
below.

## Bounds

Smaller than the stated bound (`design.md:728`). Each scenario turns on
only what it needs, so TLC explores it exhaustively.

- `worker_lock.qnt`: 1 conversation, 2 workers, 2 person actors, 2
  inputs, at most 2 losses (crash or lock expiry, counted together), 2
  post attempts per delivery, 2 turn errors. Liveness for wake-ups uses
  `wakeLive_*`: no losses and no soft pause, because `wake_*` has 20.7M
  states.
- `stop_clock.qnt`: 1 conversation, 1 person actor, 2 inputs, 1 stop,
  2 turns, 6 clock ticks.

Not modeled yet: 2 conversations (parent and child), the system actor, the
adversarial `send`, request record matching (I5, I6, I9, I12), tree stop
results (I8) and sandbox process tags (I13).

## Invariants

| Name                             | Requirement                                      | Model           |
| -------------------------------- | ------------------------------------------------ | --------------- |
| `i1_oneOpenTurn`                 | I1, rule 1, P2                                   | worker_lock     |
| `i2_finishedStaysFinished`       | I2, rule 2                                       | worker_lock     |
| `i3_noStaleSave`                 | I3, rule 3, P5                                   | worker_lock     |
| `i3_noStalePost`                 | P5 "Limit" accepts this window; expected to fail | worker_lock     |
| `versionFollowsLock`             | P5                                               | worker_lock     |
| `i7_noUndetectedDoublePost`      | I7                                               | worker_lock     |
| `restartOnlyAfterLoss`           | P4, P8, P31                                      | worker_lock     |
| `lostWorkerIsReal`               | P4                                               | worker_lock     |
| `takenOnce`                      | rule 6                                           | worker_lock     |
| `noWakeLoopWhileBlocked`         | P32                                              | worker_lock     |
| `i10_noOlderIntentAfterStop`     | I10                                              | stop_clock      |
| `i11_noOlderStartAfterStop`      | I11                                              | stop_clock      |
| `i11j_noOlderJoinAfterStop`      | I11 for join now (proposed)                      | stop_clock      |
| `spareNewerTurn`                 | turn-stop "Older stop" (proposed I14)            | stop_clock      |
| `spareNewerInput`                | turn-stop "Older stop" (proposed I14)            | stop_clock      |
| `l1_requestsEnd`                 | L1                                               | worker_lock     |
| `l2_finishingEnds`               | L2, P33                                          | worker_lock     |
| `l3_pausedResumedNoRepair`       | L3 (no fairness for the repair job)              | worker_lock     |

The stop invariants use the person's own order of actions (ghost real
times), not the design's stop test. An invariant that reuses the test
cannot see a clock mix.

## Findings

`FINDINGS.md` has each counterexample against `5ed29c2`, its trace and
the proposed fix.

## Results

TLC, exhaustive within the bounds: `results.txt` has the wall time and
distinct state count of each check. Largest: `wake_design` safety, 20.7M
states, about 7 minutes. The stop model checks take about 10 s each.

Apalache was used only for the shortest traces in `traces/`, bounded at 12
steps. No property is checked by Apalache alone. Unbounded symbolic
checks (inductive invariants) are not done.
