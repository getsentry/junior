# Protocol Model

Hand-written TLA+ models of the shared conversation core in
`openspec/changes/shared-conversation-core/` (P37), checked by TLC. They
check the plan at `c38c3d8`. A model change that changes a result also
changes `checks.txt`. `FINDINGS.md` has the counterexamples.

| File             | What it models                                                    |
| ---------------- | ----------------------------------------------------------------- |
| `WorkerLock.tla` | worker lock, lock version, turn row, errors, deliveries, wake-ups |
| `StopClock.tla`  | the stop time on the Junior receive clock (P34, P44 option 1)     |
| `Cutover.tla`    | the cutover under a rolling deploy (P45)                          |
| `cfg/`           | one TLC config per instance: the constants of a plan revision     |
| `checks.txt`     | each check and its expected result                                |
| `check.sh`       | runs the checks with TLC and compares the results                 |
| `trace.py`       | prints a TLC trace (`.out/*.trace.json`) one line per step        |
| `results.txt`    | the last full run: result, wall time and distinct states          |

## Run

Needs Java 11 or newer. `check.sh` downloads `tla2tools.jar` v1.8.0 and
checks its SHA-256, or uses `TLA2TOOLS`.

```sh
./check.sh                       # every check, one TLC run at a time
./check.sh '^Cutover'            # one model
python3 trace.py .out/cutover_midDeployFenced.oneCoreLive.trace.json
```

Expected `violated` is a known counterexample, a worked example (`ex_*`)
or accepted behavior (`acc_*`) that must be reachable. TLC searches
breadth-first, so each trace is a shortest one.

## Instances

`<scenario>_<revision>`. `priorDraft` is `ab76f5d`, `rev2` is `5122bb7`,
`rev3` is `5ed29c2`, `design` is `6c7ab79`. `noPause` is `design` without
P31. Cutover instances name the variant they turn on (see `Cutover.tla`).

## Bounds

Smaller than the target bound (`design.md`, P37). Each scenario turns on
only what it needs, so TLC explores it exhaustively.

- `WorkerLock`: 1 conversation, 2 workers, 2 inputs, at most 2 losses
  (crashes plus lock expiries), 2 post attempts per delivery, 5 turn
  errors (`design`, `rev3`, `noPause`; 2 in `priorDraft`). Liveness for
  wake-ups uses `wakeLive_*`: no losses and no soft pause.
- `StopClock`: 1 person actor, 2 inputs, 1 stop, 2 turns, 6 clock ticks.
- `Cutover`: 1 conversation, one worker of each kind (`o1` without the
  reader release, `o2` with it, `n` new core), 2 inputs, up to 2 crashes,
  2 lease or lock expiries, 3 switch flips.

Not modeled: 2 conversations (parent and child), the system actor, the
adversarial `send`, request record matching (I5, I6, I9, I12), tree stop
results (I8), sandbox process tags (I13), shared sandbox files (accepted,
P36), and the move of today's mailbox input at cutover.

## Crash Points

A `Crash_<Point>` action in `WorkerLock.tla` runs one worker step's
durable write, then the worker dies. The queue delivers its message
again. Each point is one point of the `faults` port (P42).

| Action                           | Fault point                                         |
| -------------------------------- | --------------------------------------------------- |
| `Crash_AfterAcquireLock`         | SQL: lock take and version raise (one CAS)          |
| `Crash_AfterRaiseVersion`        | SQL: separate version raise (`ab76f5d` only)        |
| `Crash_AfterStartTurn`           | SQL: `startTurn`                                    |
| `Crash_AfterRestartSave`         | SQL: restart after a lost worker                    |
| `Crash_AfterResumeSave`          | SQL: resume a pause                                 |
| `Crash_AfterSaveIntent`          | SQL: delivery intent                                |
| `Crash_AfterSaveSent`            | SQL: provider message id                            |
| `Crash_AfterSavePause`           | SQL: pause (error_retry, post_retry, soft, sign-in) |
| `Crash_AfterSaveError`           | SQL: error with no pause (`ab76f5d`, `noPause`)     |
| `Crash_AfterFinishingSave`       | SQL: `finishing` with its outcome                   |
| `Crash_AfterSaveDeliveryAttempt` | SQL: failed post attempt while finishing            |
| `Crash_AfterAnswerRecords`       | SQL: request records out of `open`                  |
| `Crash_AfterFinishedSave`        | SQL: finished status                                |
| `Crash_AfterReleaseLock`         | SQL: release (clear the token)                      |
| `Crash_AfterRedisLock`           | Redis: lock take (`ab76f5d` only)                   |
| `Crash_AfterInboxRemove`         | Redis: inbox removal after take-in                  |
| `Crash_AfterWakeCompareAndSet`   | Redis: `wakeAtMs` compare-and-set on `inboxSeq`     |
| `Crash_AfterInboxRead`           | Redis: inbox read after the release (no write)      |
| `Crash_AfterPost`                | Post: provider accepted, worker saw the reply       |
| `Crash_PostAcceptedReplyLost`    | Post: provider accepted, the reply was lost         |

A step with two writes (an inbox removal of a redelivered prompt and a
SQL save in the same `work()` step) is atomic in the model; its crash
point is the SQL write. `Cutover.tla` lets a worker crash at any step.

## Results

`results.txt`: 66 checks. TLC only, exhaustive within the bounds. No
Apalache and no inductive invariants. Largest: `wake_design` safety, 14.7M
states, 25 minutes; each `errors_design` liveness check takes about 14
minutes. A full run takes about 1 h 45 min on 4 cores.
