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
- Gate timing (Proposed, needs sign-off: P41): steps 1 to 4 fix bugs and
  words, and ship with their own scenario tests. Step G must be green before
  step 5, the first step that changes the protocol. From step 5 on, a step
  merges only when the model check, the conformance tests, the structural
  rules and the trace check are green.
- "Verify" names the invariants (I), liveness properties (L), rules (S),
  traces and scenarios that must be green after the step
  (`specs/verification/spec.md`). A step adds its own; it never removes an
  earlier one.
- Steps 3 to 13 fix today's workers. Steps 16 to 19 move each worker onto
  `work()` and delete it. The end state has one worker and no per-kind
  last-try branch.

## Steps

### 1. Retried prompt keeps its author

- [ ] 1.1 Land #2556 (still open). A retried turn does not change the author
      or the sender check of a saved message.
- Verify: its scenario test for a redelivered prompt (turn E1).
- Rollback: revert #2556.

### 2. Words

- [ ] 2.1 Change `TERMINOLOGY.md` to the words in `design.md` (P16).
- Verify: docs only.
- Rollback: revert.

### 3. One writer for the SQL status columns

- [ ] 3.1 Only turn start and turn end write `execution_status` and `run_id`.
- [ ] 3.2 Delete: the second writer in `recordExecution`.
- Verify: its scenario test; an ast-grep rule allows only the two writers
  of the copied columns (removed in step 22).
- Rollback: revert. The columns keep their shape.

### 4. Resumed plugin-started agents honor stop

- [ ] 4.1 A resumed plugin-started agent reads the saved stop.
- [ ] 4.2 Test: stop a paused plugin-started agent; the next attempt ends it
      `stopped` and the agent does not run.
- [ ] 4.3 One-line fix. No copy to delete; step 11 deletes the stop
      variants.
- Verify: turn-stop › Stop during a pause.
- Rollback: revert the one-line fix.

### G. Verification gate

Needs: P37, P38, P39, P40, P41, P42.

- [ ] G.1 Add `verification/` at the repo root (P40) with the model from
      the `core-model` draft. CI runs Apalache for the safety invariants,
      TLC for the liveness properties, and every worked example as a named
      trace.
- [ ] G.2 Add the scenario-id list and the trace check there. At the gate, a
      scenario may map only to a model invariant or trace. The step that
      builds the behavior adds its test id.
- [ ] G.3 Add the conformance harness (P38, P42) on the integration harness.
      Its first suite checks only what today's code already holds.
- [ ] G.4 Add the structural check runner. Each rule lands with the step
      that makes it true.
- Verify: the model holds I1–I13 and L1–L3 within the bound; every scenario
  maps; the conformance suite is green.
- Rollback: CI only. Remove the jobs.

### 5. SQL worker lock, lock version and wake time

Needs: P5, P32, P43.

- [ ] 5.1 Add lock token, expiry and version to the conversation row. Take
      the lock with the compare-and-set. Check in and release with the
      token and version. All lock times use database `now()`.
- [ ] 5.2 Workers hold the SQL lock and today's Redis lease together, so
      old workers stay excluded.
- [ ] 5.3 Add `nextRunAtMs`, the one runnable test. Before release, set
      `wakeAtMs` with a compare-and-set on `inboxSeq`. Release, then
      re-check. Never release while the turn is `running`.
- [ ] 5.4 Test: a slow worker after a takeover cannot check in (turn E3); a
      message while the lock is held (turn E7).
- Verify: I3 for lock take and check-in; L3 without repair fairness; S5 for
  lock writes; turn-lifecycle › Slow worker save; conversation-inbox ›
  Message while the lock is held; traces turn E3, E7 and access E2.
- Rollback: the Redis lease still guards. The columns go unused. Old
  workers ignore `inboxSeq`; `send()` still sets `wakeAtMs`.

### 6. Turn rows: reader release

Needs: P2, P10, P30, P31, P34.

- [ ] 6.1 Add the turn table and the one-open index. Workers run a turn
      stored as a row: `startTurn` in one transaction, fenced
      `saveCheckpoint`, a finished guard.
- [ ] 6.2 Readers for every state a later step writes: `finishing`,
      `error_retry`, the renamed pause reasons and the stop time.
- [ ] 6.3 New turns still start in the Redis turn cursor. Add a finished
      guard to cursor writes.
- [ ] 6.4 Test: a late save to a finished turn is refused.
- Verify: I1 and I2 for turns stored as rows; S6 added; turn-lifecycle ›
  Late save.
- Rollback: no rows or new states are written yet.

### 7. Turn rows: writer release

Needs: P2.

- [ ] 7.1 New turns start as rows. A worker that takes the lock and finds an
      open cursor moves it into a row keyed by its turn id (insert once,
      then delete the cursor), so a repeat after a crash does nothing new.
      No read fallback.
- [ ] 7.2 Stop and sign-in key by turn id.
- [ ] 7.3 Test: redelivered prompt (turn E1).
- [ ] 7.4 Delete: Slack `activeTurnId` and new cursor writes.
- Verify: I1, I2, I3 and I12 for all new turns; turn-lifecycle › Second
  start, Cutover from the old turn cursor, Crash between commit and inbox
  removal; trace turn E1.
- Rollback: step 6 runs rows.

### 8. Drop the Redis lease and turn cursor

- [ ] 8.1 Ship after a count shows no open cursor.
- [ ] 8.2 Delete: the Redis lease, the turn cursor code and the per-turn
      Redis mutation lock.
- Verify: I1 holds across the cutover; S6 forbids the old cursor.
- Rollback: step 7 workers also hold the SQL lock.

### 9. Delivery ids, intents and pause reasons

Needs: P5, P10, P11.

- [ ] 9.1 Give each response a fixed delivery id. Before each post, save a
      checkpoint that commits the response to history and records the
      intent with its text. Check `find` before a repeat post. Send the
      saved text.
- [ ] 9.2 Split `retry`; rename `yield` and `timeout` (writers; step 6
      shipped the readers).
- [ ] 9.3 Test: two outcomes, second fails (edges E1).
- [ ] 9.4 Delete: the post-then-commit guard in each provider turn.
- Verify: I7; turn-lifecycle › Two outcomes, second fails and Restart after
  an intent; trace edges E1; crash point "provider accepted, reply lost".
- Rollback: step 6 readers handle the new pause reasons. Old workers ignore
  saved intents.

### 10. One `finishTurn`

Needs: P4, P8, P12, P22, P30, P31, P33.

- [ ] 10.1 Add `finishTurn` (resumable through `finishing`, using step 9's
      delivery ids) and `closeInput`. Today's four last-try branches call it
      with the reply target as data. Steps 16 to 19 delete those branches.
- [ ] 10.2 Errors pause `error_retry`. A turn is lost only when `running`
      under an expired lock. The timer job only notifies a worker.
- [ ] 10.3 Delivery attempts and backoff while finishing. A permanent
      provider error fails the delivery at once.
- [ ] 10.4 Write one `turn.terminal` event per turn end.
- [ ] 10.5 Test: dead worker (turn E2), retries running out (turn E4) and
      stuck delivery (turn E6).
- [ ] 10.6 Delete: the lost-worker fallback in the timer job and the second
      status-to-end mapping.
- Verify: I2, I4 and S1 added; L2; turn-lifecycle › Crash during finish,
  Retries run out, Error message cannot be posted; traces turn E2, E4, E6.
- Rollback: step 6 readers still handle the `finishing` and `error_retry`
  rows this step wrote.

### 11. One stop

Needs: P34, P35.

- [ ] 11.1 `stop()` saves the stop input's `createdAtMs` as the stop time on
      the conversation and every conversation below it, and notifies each
      worker. Slack stop, dashboard stop, ACP stop and thread opt-out all
      call it.
- [ ] 11.2 `startTurn`, every fenced save and every intent save refuse when
      the stop time is after the turn start. Today's child worker reads the
      stop time.
- [ ] 11.3 Test: top-level stop of a tree (agents E3).
- [ ] 11.4 Delete: the opt-out-only tree walk and the stop variants per
      entry point.
- Verify: I8 for today's child results, I10 and I11; L1 under stop;
  turn-stop › Stop races a turn start; traces turn E5, agents E3 and E4.
- Rollback: revert. Saved stop times stay readable by step 6 readers.

### 12. One credential builder and the sandbox pass

Needs: P17, P36, and the shared-file decision (Decisions Needed 39).

- [ ] 12.1 Add `credentialsForTurn` and `bindSubject` (signature covers the
      run). Check at every start and resume.
- [ ] 12.2 One pass per turn on the turn row. The proxy checks it against
      the open turn, `running`, with a live lock. No-credentials policy at
      finish and at the listed pauses. Kill user processes when the actor
      or access changes.
- [ ] 12.3 The shared-file mitigations, as decided.
- [ ] 12.4 Document one sandbox per conversation in the user docs.
- [ ] 12.5 Test: background process after the turn (access E5).
- [ ] 12.6 Delete: the other turn credential builders, and the pass that
      lasts for the sandbox timeout.
- Verify: I5 for credentials and I13; S2 added; turn-access › Background
  process after the turn, Pass from an older turn; traces access E4, E5.
- Rollback: revert the release. Saved pass ids are unused.

### 13. One sign-in rule

Needs: P13.

- [ ] 13.1 Same-person input supersedes; others wait until sign-in or expiry.
      System-actor turns end `blocked`.
- [ ] 13.2 Test: access E1, E2 and E3.
- [ ] 13.3 Delete: Slack `pendingAuth`, the silent web supersede, and the
      "newer sign-in replaces" path.
- Verify: L3 for sign-in waits; turn-access › Same person, Another person;
  traces access E1, E2 and E3.
- Rollback: revert. Saved `sign_in` pauses are read by step 6 readers.

### 14. Request records: reader release

Needs: P23, P26.

- [ ] 14.1 Readers (`listAgents`, the dashboard, result handling, the plugin
      view) read request records when present, else today's rows. They
      read result records (`answers`, `sentBy`).
- [ ] 14.2 `selectTurnInput` runs the match check when a record exists.
- Verify: I9 for messages with a record; conversation-inbox › Message
  points at another record.
- Rollback: no records exist yet.

### 15. Request records: writer release

Needs: P7, P15, P20, P26, P39.

- [ ] 15.1 Core ingress, `askChild` and `startPluginAgent` mint records.
      `finishTurn` and `messageParent` mint result records in the parent,
      in the child's transaction. `createRequest` binds the subject after
      it mints the id. Today's rows are still written.
- [ ] 15.2 The repair job works on records and the wake-time index.
- [ ] 15.3 Add `VerifiedPersonActor`, the agent-message type, the import
      boundary for `createRequest` and `send`, and their runtime asserts.
- [ ] 15.4 Test: a forged result (agents E5) and a mismatched record (inbox
      E5).
- [ ] 15.5 Add guardian eval cases for P15 outside text and P20 "never
      approval".
- [ ] 15.6 Delete: "copy the latest request" for result actors.
- Verify: I5 for records and I9; S3 and S4; agent-tree › Forged result;
  turn-access › Grandchild result after another person messaged the child;
  traces inbox E5, agents E5 and edges E2; the guardian cases.
- Rollback: step 14 reads both.

### 16. Slack on `work()`

- [ ] 16.1 Slack conversations run in `work()`.
- [ ] 16.2 Delete: `task-execution/slack-work.ts` and its last-try branch.
- Verify: I6 for Slack; conversation-inbox › Another person, Plain reply
  from the turn's own person; traces inbox E1, E2 and E4.
- Rollback: revert the release. Turn rows and records stay readable.

### 17. Web and events on `work()`

- [ ] 17.1 Web and event conversations run in `work()`.
- [ ] 17.2 Delete: the web and event worker paths in
      `task-execution/conversation-turn.ts` and `mailbox-turn.ts`, their
      last-try branch, and `task-execution/web-steering.ts`.
- Verify: I6 for web and events; L3; conversation-inbox › Web and event
  input; traces inbox E3 and edges E3.
- Rollback: revert the release. Turn rows and records stay readable.

### 18. Child agents on `work()`

Needs: P6.

- [ ] 18.1 `askChild` only sends. Child turns run in `work()`. Results go to
      the parent inbox at `finishTurn`.
- [ ] 18.2 Report or move live `replaced` requests before the cutover.
- [ ] 18.3 Test: busy child (agents E1) and grandchild result (agents E2).
- [ ] 18.4 Delete: the child runner in `agent-invocations/work.ts`, its
      last-try branch and `reportNow`.
- Verify: I8 in full; L1 for children; agent-tree › Same actor, Grandchild
  result after the child's turn ended; traces agents E1 and E2.
- Rollback: revert the release. Today's runner reads child records through
  step 14 readers. `replaced` stays readable until step 20.

### 19. Plugin-started agents on `work()`

Needs: P14, P18, P21.

- [ ] 19.1 Plugin-started runs use `work()`. Plugins read the computed view.
- [ ] 19.2 Test: an Automation run through `finishTurn`.
- [ ] 19.3 Delete: the runner in `agent-dispatch/work.ts`, its last-try
      branch, the outbox sweep and the 24 h failure rule.
- Verify: L1 for plugin-started runs; trace edges E1.
- Rollback: revert the release. Dispatch records are still written until
  step 20.

### 20. Stop writing today's rows

- [ ] 20.1 One release after steps 18 and 19, stop writing Agent invocation
      run statuses and dispatch records.
- [ ] 20.2 Delete: the result sweep, the fallback reads from step 14 and
      `replaced`.
- [ ] 20.3 Set the `maxAgentDepth` default to 1 (Decided).
- Verify: S1 has no exceptions left; agent-tree › Grandchild spawns.
- Rollback: revert the release. The depth default is a config value.

### 21. The CLI through the inbox

- [ ] 21.1 `pnpm cli -- chat` uses core person ingress and runs `work()`
      locally.
- [ ] 21.2 Delete: the CLI's direct turn path.
- Verify: conversation-inbox › Duplicate CLI input.
- Rollback: revert. The CLI is local.

### 22. Clean up

Needs: P3.

- [ ] 22.1 Drop `execution_status` and `run_id` one release after no code
      reads them. Drop the old tables after a dry run.
- [ ] 22.2 Move lasting rules into code, tests and policies. Delete this
      plan. CI keeps running `verification/`, which reads nothing here.
- Verify: every check from steps G to 21 is still green.
- Rollback: a column drop cannot be undone; the dry run comes first.
