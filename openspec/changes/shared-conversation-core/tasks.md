# Tasks

## How To Use This Plan

- Each step ships alone, leaves `main` correct, deletes the copy it
  replaces, and rolls back alone. A step that only adds a layer is not done.
- Each step uses only what earlier steps added.
- Rolling deploy: old and new workers run at the same time. Readers ship one
  release before writers. A "writer" step starts only after its reader step
  is fully deployed.
- At the start of each step, check this plan against current `main`.
- Each step adds or extends an integration test through the real worker
  (`policies/testing.md`). Fake only Slack and LLMs.
- "Needs" lists the decisions (`design.md`, Decisions Needed) that must be
  signed off first. A change to a decided rule needs David's OK.
- The gate (P41): a step merges only when the model check, the conformance
  tests and the structural rules are green and the trace check shows no
  gap. "Verify" names the invariants (I), liveness properties (L), rules
  (S) and traces that the step adds or makes required
  (`specs/verification/spec.md`).
- Steps 3 to 13 fix today's workers. Steps 16 to 19 move each worker onto
  `work()` and delete it. The end state has one worker and no per-kind
  last-try branch.

## Steps

### 0. Verification gate

Needs: P37, P38, P39, P40, P41.

- [ ] 0.1 Check in the model in `verification/` (drafted separately). It
      checks I1–I8 and L1–L3 and runs every worked example as a named trace.
- [ ] 0.2 Add a CI job that runs the model checker.
- [ ] 0.3 Add the conformance harness against today's code. List the
      invariants today's code breaks as expected to fail, each with the
      step that fixes it.
- [ ] 0.4 Add the trace check. Map every scenario in `specs/`.
- Ships before any step that changes protocol code. Steps 1 and 2 may land
  first; their Verify lines run once step 0 lands.

### 1. Retried prompt keeps its author

- [ ] 1.1 Land #2556 (still open). A retried turn does not change the author
      or the sender check of a saved message.
- Verify: a conformance run of turn E1 shows the saved author kept.

### 2. Words

- [ ] 2.1 Change `TERMINOLOGY.md` to the words in `design.md` (P16).
- Verify: the trace check still matches every scenario id.

### 3. One writer for the SQL status columns

- [ ] 3.1 Only turn start and turn end write `execution_status` and `run_id`.
- [ ] 3.2 Delete: the second writer in `recordExecution`.
- Verify: an ast-grep rule allows only the two writers of the copied
  columns (removed in step 22).

### 4. Resumed plugin-started agents honor stop

- [ ] 4.1 A resumed plugin-started agent reads the saved stop.
- [ ] 4.2 Test: stop a paused plugin-started agent; the next attempt ends it
      `stopped` and the agent does not run.
- [ ] 4.3 One-line fix. No copy to delete; step 11 deletes the stop
      variants.
- Verify: a conformance stop trace for a paused plugin-started agent.

### 5. SQL worker lock and lock version

Needs: P5.

- [ ] 5.1 Add lock token, expiry and version to the conversation row. Take
      the lock with the compare-and-set. Check in and release with the
      token and version.
- [ ] 5.2 Workers hold the SQL lock and today's Redis lease together, so
      old workers stay excluded.
- [ ] 5.3 Test: a slow worker after a takeover cannot check in (turn E3).
- Rollback: the Redis lease still guards. The columns go unused.
- Verify: I3 for lock take and check-in; S5 starts with the lock writes;
  trace turn E3.

### 6. Turn rows: reader release

Needs: P2, P30, P31.

- [ ] 6.1 Add the turn table and the one-open index. Workers run a turn
      stored as a row: `startTurn` in one transaction, fenced
      `saveCheckpoint`, a finished guard.
- [ ] 6.2 New turns still start in the Redis turn cursor. Add a finished
      guard to cursor writes.
- [ ] 6.3 Test: a late save to a finished turn is refused.
- Rollback: no rows exist yet.
- Verify: I1 and I2 required for turns stored as rows; S6 added.

### 7. Turn rows: writer release

Needs: P2.

- [ ] 7.1 New turns start as rows. A worker that takes the lock and finds an
      open cursor moves it into a row and deletes the cursor in that locked
      step. No read fallback.
- [ ] 7.2 Stop and sign-in key by turn id.
- [ ] 7.3 Test: redelivered prompt (turn E1).
- [ ] 7.4 Delete: Slack `activeTurnId` and new cursor writes.
- Rollback: step 6 runs rows.
- Verify: I1, I2 and I3 required for all new turns; traces turn E1 and E7.

### 8. Drop the Redis lease and turn cursor

- [ ] 8.1 Ship after a count shows no open cursor.
- [ ] 8.2 Delete: the Redis lease, the turn cursor code and the per-turn
      Redis mutation lock.
- Rollback: step 7 workers also hold the SQL lock.
- Verify: S6 forbids the old cursor; I1 holds across the cutover.

### 9. One `finishTurn`

Needs: P4, P8, P12, P22, P30, P31.

- [ ] 9.1 Add `finishTurn` (resumable through `finishing`) and `closeInput`.
      Today's four last-try branches call it with the reply target as
      data. Steps 16 to 19 delete those branches.
- [ ] 9.2 Errors pause `error_retry`. A turn is lost only when `running`
      under an expired lock. The timer job only notifies a worker.
- [ ] 9.3 Write one `turn.terminal` event per turn end.
- [ ] 9.4 Test: retries running out (turn E4) and a dead worker (turn E2).
- [ ] 9.5 Delete: the lost-worker fallback in the timer job and the second
      status-to-end mapping.
- Verify: I4 and S1 added; L2 in part; traces turn E2 and E4.

### 10. Delivery intents and pause reasons

Needs: P5, P10, P11, P33.

- [ ] 10.1 Save a delivery intent with its text before each post. Check
      `find` before a repeat post. Send the saved text.
- [ ] 10.2 Delivery attempts and backoff while finishing.
- [ ] 10.3 Split `retry`; rename `yield` and `timeout`.
- [ ] 10.4 Test: two outcomes, second fails (edges E1); stuck delivery (turn
      E6).
- [ ] 10.5 Delete: the post-then-commit guard in each provider turn.
- Verify: I7 and L2 required; traces turn E6 and edges E1.

### 11. One stop

Needs: P34, P35.

- [ ] 11.1 `stop()` saves a stop time on the conversation and every
      conversation below it, and notifies each worker. `startTurn` checks
      it. Slack stop, dashboard stop, ACP stop and thread opt-out all call
      it.
- [ ] 11.2 Today's child worker reads the stop time.
- [ ] 11.3 Test: top-level stop of a tree (agents E3).
- [ ] 11.4 Delete: the opt-out-only tree walk and the stop variants per
      entry point.
- Verify: I8 for today's child results; L1 under stop; traces turn E5,
  agents E3 and E4.

### 12. One credential builder and the sandbox pass

Needs: P17, P36.

- [ ] 12.1 Add `credentialsForTurn` and `bindSubject` (signature covers the
      run). Check at every start and resume.
- [ ] 12.2 One pass per turn on the turn row. The proxy checks it against
      the open turn. No-credentials policy at finish and at the listed
      pauses. Kill user processes when the actor or access changes.
- [ ] 12.3 Document one sandbox per conversation in the user docs.
- [ ] 12.4 Test: background process after the turn (access E5).
- [ ] 12.5 Delete: the other turn credential builders, and the pass that
      lasts for the sandbox timeout.
- Verify: I5 for credentials and S2 added; trace access E4. Access E5
  (processes) is a conformance test only.

### 13. One sign-in rule

Needs: P13.

- [ ] 13.1 Same-person input supersedes; others wait until sign-in or expiry.
      System-actor turns end `blocked`.
- [ ] 13.2 Test: access E1, E2 and E3.
- [ ] 13.3 Delete: Slack `pendingAuth`, the silent web supersede, and the
      "newer sign-in replaces" path.
- Verify: L3 for sign-in waits; traces access E1, E2 and E3.

### 14. Request records: reader release

Needs: P23, P26.

- [ ] 14.1 Readers (`listAgents`, the dashboard, result handling, the plugin
      view) read request records when present, else today's rows.
- [ ] 14.2 `selectTurnInput` runs the match check when a record exists.
- Rollback: no records exist yet.
- Verify: the conformance comparison reads request records.

### 15. Request records: writer release

Needs: P7, P15, P20, P26.

- [ ] 15.1 Core ingress, `askChild` and `startPluginAgent` mint records.
      They still write today's rows.
- [ ] 15.2 The repair job works on records.
- [ ] 15.3 Test: a forged result (agents E5) and a mismatched record (inbox
      E5).
- [ ] 15.4 Delete: "copy the latest request" for result actors.
- Rollback: step 14 reads both.
- Verify: I5 for records and S3 added; traces inbox E5, agents E5 and
  edges E2.

### 16. Slack on `work()`

- [ ] 16.1 Slack conversations run in `work()`.
- [ ] 16.2 Delete: `task-execution/slack-work.ts` and its last-try branch.
- Verify: I6 for Slack; traces inbox E1, E2 and E4 run on `work()`. Slack
  entries leave the expected-to-fail list.

### 17. Web and events on `work()`

- [ ] 17.1 Web and event conversations run in `work()`.
- [ ] 17.2 Delete: the web and event worker paths in
      `task-execution/conversation-turn.ts` and `mailbox-turn.ts`, their
      last-try branch, and `task-execution/web-steering.ts`.
- Verify: I6 for web; L3; traces inbox E3 and edges E3. Web and event
  entries leave the expected-to-fail list.

### 18. Child agents on `work()`

Needs: P6.

- [ ] 18.1 `askChild` only sends. Child turns run in `work()`. Results go to
      the parent inbox at `finishTurn`.
- [ ] 18.2 Set `maxAgentDepth` default to 1.
- [ ] 18.3 Report or move live `replaced` requests before the cutover.
- [ ] 18.4 Test: busy child (agents E1) and grandchild result (agents E2).
- [ ] 18.5 Delete: the child runner in `agent-invocations/work.ts`, its
      last-try branch, `replaced` and `reportNow`.
- Verify: I8 in full, L1 for children and S4 added; traces agents E1 and E2.

### 19. Plugin-started agents on `work()`

Needs: P14, P18, P21.

- [ ] 19.1 Plugin-started runs use `work()`. Plugins read the computed view.
- [ ] 19.2 Test: an Automation run through `finishTurn`.
- [ ] 19.3 Delete: the runner in `agent-dispatch/work.ts`, its last-try
      branch, the outbox sweep and the 24 h failure rule.
- Verify: L1 for plugin-started runs; trace edges E1.

### 20. Stop writing today's rows

- [ ] 20.1 One release after steps 18 and 19, stop writing Agent invocation
      run statuses and dispatch records.
- [ ] 20.2 Delete: the result sweep and the fallback reads from step 14.
- Verify: S1 has no exceptions left.

### 21. The CLI through the inbox

- [ ] 21.1 `pnpm cli -- chat` uses core person ingress and runs `work()`
      locally.
- [ ] 21.2 Delete: the CLI's direct turn path.
- Verify: the inbox traces also run with the CLI kind.

### 22. Clean up

Needs: P3.

- [ ] 22.1 Drop `execution_status` and `run_id` one release after no code
      reads them. Drop the old tables after a dry run.
- [ ] 22.2 Move lasting rules into code, tests and policies. Delete this
      plan.
- Verify: the expected-to-fail list is empty. Move the model and scenario
  ids per P40.
