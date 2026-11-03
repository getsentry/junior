# Tasks

## How To Use This Plan

- Full design first (Decided: P1). Three phases:
  1. Pre-work: steps 1, 2 and G. Each ships alone and rolls back alone.
  2. Build: steps 3 to 13 build the new core beside today's code. It is not
     wired to production traffic. The conformance tests and the gate run
     against it. A build step changes no production behavior, so its
     rollback is a revert.
  3. Cut over and delete: step 14 teaches today's code to read the new
     core, step 15 routes every kind through `work()`, step 16 deletes
     today's workers and records, and step 17 deletes this plan.
- Rolling deploy: old and new workers run at the same time. Readers ship one
  release before writers. A "writer" step starts only after its reader step
  is fully deployed. P45 says how the cutover stays safe.
- At the start of each step, check this plan against current `main`.
- Each step adds or extends an integration test through the real worker
  (`policies/testing.md`). Fake only Slack and LLMs.
- "Needs" lists the decisions (`design.md`, Decisions Needed) that must be
  signed off first. A change to a decided rule needs David's OK.
- Gate timing (Proposed, needs sign-off: P41): step G, with the model
  complete (G.1a–G.1f), must be green before the cutover release (step 15).
  A build step merges only when the checks its Verify line names are green
  against the new core.
- "Verify" names the invariants (I), liveness properties (L), rules (S),
  traces and scenarios that must be green after the step
  (`specs/verification/spec.md`). A step adds its own; it never removes an
  earlier one.
- Risk: one large cutover, and no smaller-option fixes for today's workers
  before it.

## Pre-Work

### 1. Retried prompt keeps its author

- [ ] 1.1 Land #2556 (still open). A retried turn does not change the author
      or the sender check of a saved message.
- Verify: its scenario test for a redelivered prompt (turn E1).
- Rollback: revert #2556.

### 2. Words

- [ ] 2.1 Change `TERMINOLOGY.md` to the words in `design.md` (P16).
- Verify: docs only.
- Rollback: revert.

### G. Verification gate

Needs: P37, P38, P39, P40, P41, P42, P44.

- [ ] G.1 Merge repo-root `verification/` (P40) from branch
      `spec/shared-conversation-core-model` (7ca64c2: `worker_lock.qnt`,
      `stop_clock.qnt`, `FINDINGS.md`, `traces/`). CI runs `check.sh` with
      TLC for safety and liveness, and every worked example as a named
      trace.
- [ ] G.1a Model parent and child conversations and the system actor.
- [ ] G.1b Model the adversarial `send`.
- [ ] G.1c Model request-record matching: I5, I6, I9 and I12.
- [ ] G.1d Model tree-stop results: I8, and P35 on one clock (P44).
- [ ] G.1e Model sandbox process tags: I13.
- [ ] G.1f Grow the bound toward the P37 target bound, and model the P44
      choice for cross-clock stops.
- [ ] G.2 Add the scenario-id list and the trace check there. At the gate, a
      scenario may map only to a model invariant or trace. The step that
      builds the behavior adds its test id.
- [ ] G.3 Add the conformance harness (P38, P42) on the integration harness.
      It runs against the new core as each build step lands.
- [ ] G.4 Add the structural check runner. Each rule lands with the step
      that makes it true.
- Verify: the model holds I1–I14 and L1–L3 within the bound; every scenario
  maps. Step G is not green until G.1a to G.1f are modeled, and it is green
  before the cutover release (step 15).
- Rollback: CI only. Remove the jobs.

## Build The New Core

### 3. SQL worker lock, lock version and wake time

Needs: P32.

- [ ] 3.1 Add lock token, expiry and version to the conversation row. Take
      the lock with the compare-and-set. Check in and release with the
      token and version. All lock times use database `now()`.
- [ ] 3.2 Add `nextRunAtMs`, the one runnable test. Before release, set
      `wakeAtMs` with a compare-and-set on `inboxSeq` and queue a delayed
      notify for it. Release, then read the inbox record again. Never
      release while the turn is `running`.
- [ ] 3.3 `recordSignIn` raises `inboxSeq` and sets `wakeAtMs` to now
      before it notifies.
- [ ] 3.4 Measure the check-in load (P43 switch rule).
- [ ] 3.5 Test: a slow worker after a takeover cannot check in (turn E3); a
      message while the lock is held (turn E7); a sign-in while the lock is
      held.
- Verify: I3 for lock take and check-in; L3 without repair fairness; S5 for
  lock writes; turn-lifecycle › Slow worker save; conversation-inbox ›
  Message while the lock is held; traces turn E3, E7, access E2 and
  `wake_l3NoRepair_signInDuringLock` (now holds).

### 4. Turn rows

Needs: P10, P30, P31, P34.

- [ ] 4.1 Add the turn table (with `oldestInputCreatedAtMs`) and the
      one-open index. `startTurn` in one transaction, fenced
      `saveCheckpoint`, a finished guard.
- [ ] 4.2 Every turn state: `finishing`, `error_retry`, the five pause
      reasons and the stop time.
- [ ] 4.3 Test: a late save to a finished turn is refused; a redelivered
      prompt (turn E1).
- Verify: I1, I2, I3 and I12; S6; turn-lifecycle › Second start, Late save,
  Crash between commit and inbox removal; trace turn E1.

### 5. Request records and `send()`

Needs: P9, P23, P26, P39.

- [ ] 5.1 `createRequest` mints the record, then binds the subject (P17).
      Core ingress, `askChild` and `startPluginAgent` mint records.
- [ ] 5.2 `send()` appends, raises `inboxSeq`, sets `wakeAtMs` and
      notifies. Duplicates by message id.
- [ ] 5.3 Add `VerifiedPersonActor`, the agent-message type, the import
      boundary for `createRequest` and `send`, and their runtime asserts.
- [ ] 5.4 Test: a mismatched record (inbox E5).
- Verify: I9; S3 and S4; conversation-inbox › Message points at another
  record, Missing record, Provider retry, Copy while waiting; traces inbox
  E1 and E5.

### 6. `work()`

Needs: P7, P9, P30.

- [ ] 6.1 `work()` takes the lock and runs the first case that applies.
      `selectTurnInput` runs the match check and groups input by actor,
      exact signed subject and source (P20). `canJoin` for joins.
- [ ] 6.2 Closing turns through `closeInput`.
- [ ] 6.3 The repair job works on records and the wake-time index.
- [ ] 6.4 Test: batch split by actor (inbox E2), events with different
      access (inbox E3), a plain reply from the turn's own person (inbox
      E4).
- Verify: I6 for every source, with one actor and one exact subject per
  taken batch; L3; conversation-inbox › Interleaved people, Web and event
  input, Events with different access, Another person, Plain reply from
  the turn's own person; traces inbox E2, E3, E4 and edges E3.

### 7. Delivery records

Needs: P10, P11.

- [ ] 7.1 Give each response a fixed delivery id. Before each post, save a
      checkpoint that commits the response to history and records the
      intent with its text. Check `find` before a repeat post. Send the
      saved text.
- [ ] 7.2 The split `retry` pause and the renamed `yield` and `timeout`.
- [ ] 7.3 Test: two outcomes, second fails (edges E1).
- Verify: I7; turn-lifecycle › Two outcomes, second fails and Restart after
  an intent; trace edges E1; crash point "provider accepted, reply lost".

### 8. `finishTurn()`

Needs: P4, P8, P12, P22, P30, P31, P33.

- [ ] 8.1 Add `finishTurn` (resumable through `finishing`, using step 7's
      delivery ids). The reply target is data, with no branch on kind.
- [ ] 8.2 Errors pause `error_retry`. A turn is lost only when `running`
      under an expired lock. The timer job only notifies a worker.
- [ ] 8.3 Delivery attempts and backoff while finishing. A permanent
      provider error fails the delivery at once.
- [ ] 8.4 Write one `turn.terminal` event per turn end.
- [ ] 8.5 Test: dead worker (turn E2), retries running out (turn E4) and
      stuck delivery (turn E6).
- Verify: I2, I4 and S1; L2; turn-lifecycle › Crash during finish, Retries
  run out, Error message cannot be posted; traces turn E2, E4, E6.

### 9. Stop

Needs: P34, P44.

- [ ] 9.1 `stop()` saves the stop input's `createdAtMs` as the stop time on
      the conversation and every conversation below it, and notifies each
      worker. Slack stop, dashboard stop, ACP stop and thread opt-out all
      call it.
- [ ] 9.2 A turn is under the stop when its oldest taken-in input is older
      than the stop time. `startTurn` and joins refuse older input. Every
      fenced save and intent save of a turn under the stop refuses.
      `finishTurn(stopped)` puts newer taken-in input back in the inbox.
- [ ] 9.3 Cross-clock stops, as P44 decides.
- [ ] 9.4 Test: top-level stop of a tree (agents E3); stop of a paused
      plugin-started agent.
- Verify: I8, I10, I11 (with joins) and I14; L1 under stop; turn-stop ›
  Stop races a turn start, Turn started after the click, Older input tries
  to join, Newer input joined before the stop, Stop during a pause; traces
  turn E5, agents E3 and E4, and the `stop_*` traces; turn-stop › Late
  result after a tree stop, Late result after stopAgent, Result in flight
  at the stop, Dashboard stop of a child.

### 10. Sign-in

Needs: P13.

- [ ] 10.1 Same-person input supersedes; others wait until sign-in or
      expiry. System-actor turns end `blocked`.
- [ ] 10.2 Test: access E1, E2 and E3.
- Verify: L3 for sign-in waits; turn-access › Same person, Another person;
  traces access E1, E2 and E3.

### 11. Child agents and results

- [ ] 11.1 `askChild` only sends. Child turns run in `work()`. `finishTurn`
      and `messageParent` mint result records in the parent, in the child's
      transaction.
- [ ] 11.2 Add guardian eval cases for P15 outside text and P20 "never
      approval".
- [ ] 11.3 Test: busy child (agents E1), grandchild result (agents E2) and
      a forged result (agents E5).
- Verify: I5 for records, I8 and I9; L1 for children; agent-tree › Same
  actor, Grandchild result after the child's turn ended, Forged result,
  Result wakes an idle parent, Two siblings finish together;
  turn-access › Grandchild result after another person messaged the child;
  traces agents E1, E2, E5 and edges E2; the guardian cases.

### 12. Plugin-started agents

Needs: P14, P18, P21.

- [ ] 12.1 Plugin-started runs use `work()`. An Automation run has
      `replyTo: stored` and `outcomes` on its record; `finishTurn` delivers
      its one result to each outcome (P18). Plugins read the computed view.
- [ ] 12.2 Test: an Automation run through `finishTurn` (edges E1).
- Verify: L1 for plugin-started runs; plugin-started-agents › Draft stays
  in the web view, Result from the final response, Result from the tool
  call, No action, Misconfigured, Empty outcomes, Result already sent;
  trace edges E1.

### 13. Credentials and the sandbox pass

Needs: P36, and the shared-file decision (Decisions Needed 29).

- [ ] 13.1 Add `credentialsForTurn` and `bindSubject` (signature covers the
      run). Check at every start and resume.
- [ ] 13.2 One pass per turn on the turn row. The proxy checks it against
      the open turn, `running`, with a live lock. No-credentials policy at
      finish and at the listed pauses. Kill user processes when the actor
      or access changes.
- [ ] 13.3 The shared-file mitigations, as decided.
- [ ] 13.4 Test: background process after the turn (access E5).
- Verify: I5 for credentials and I13; S2; turn-access › Background process
  after the turn, Pass from an older turn; traces access E4, E5.

## Cut Over And Delete

### 14. Cutover reader release

Needs: P45.

- [ ] 14.1 Add the `core` owner field to the conversation row (P45).
      Today's workers read it and refuse a conversation that the new core
      owns. They move an idle new-core conversation back to today's
      workers (the rollback path).
- [ ] 14.2 Readers (`listAgents`, the dashboard, reporting, result handling
      and the plugin view) read turn rows and request records for a
      new-core conversation, else today's rows.
- [ ] 14.3 Test: an old worker refuses a new-core conversation.
- Verify: every check from steps G to 13.
- Rollback: revert. No conversation is new core yet.

### 15. Cutover release

Needs: P45.

- [ ] 15.1 Every kind runs through `work()`: Slack, web and ACP, events,
      Automations, plugin-started agents, child agents and the CLI
      (`pnpm cli -- chat` uses core ingress and runs `work()` locally).
- [ ] 15.2 The first new-core lock take of a conversation moves its state
      (P45): an open Redis turn cursor into a turn row keyed by its turn id,
      active Agent invocation rows and dispatch records into request
      records, Slack `activeTurnId` and `pendingAuth` into the turn row.
      Each move inserts once and then deletes the old state, so a repeat
      after a crash does nothing new.
- [ ] 15.3 Report or move live `replaced` requests before the cutover.
- [ ] 15.4 Set the `maxAgentDepth` default to 1 (Decided).
- [ ] 15.5 Document one sandbox per conversation in the user docs.
- [ ] 15.6 Test: a conversation with an open Redis turn cursor and a
      running child agent moves on its first lock take.
- Verify: the gate is green; I1 holds across the move; turn-lifecycle ›
  Cutover from the old turn cursor; agent-tree › Grandchild spawns;
  conversation-inbox › Duplicate CLI input.
- Rollback (P45): switch the cutover off. No more conversations move, and
  each new-core conversation goes back to today's workers at its next lock
  take once it has no open turn and no open record. Open new-core work
  finishes on the new core first. When a count shows no new-core
  conversation, revert to the step 14 release.

### 16. Delete release

- [ ] 16.1 Ships after a count shows no old-core conversation, no open Redis
      turn cursor and no worker older than step 15.
- [ ] 16.2 Delete today's workers: `task-execution/slack-work.ts`, the web
      and event paths in `task-execution/conversation-turn.ts` and
      `mailbox-turn.ts`, `task-execution/web-steering.ts`, the child runner
      in `agent-invocations/work.ts` with `reportNow`, the runner in
      `agent-dispatch/work.ts`, the CLI's direct turn path, and each
      last-try branch.
- [ ] 16.3 Delete today's records and states: Agent invocation run
      statuses, dispatch records, `replaced`, `steered` and `skipped`, the
      Redis lease, the turn cursor, the per-turn Redis mutation lock, Slack
      `activeTurnId` and `pendingAuth`.
- [ ] 16.4 Delete the repair sweeps: the result sweep, the outbox sweep, the
      24 h failure rule and the lost-worker fallback in the timer job.
- [ ] 16.5 Delete the copies: every reader and writer of the copied
      `execution_status` and `run_id` columns (P3), the second
      status-to-end mapping, the step 14 fallback reads, the
      post-then-commit guard, the opt-out-only tree walk and the stop
      variants per entry point, the other credential builders, the pass
      that lasts for the sandbox timeout, the silent web supersede, the
      "newer sign-in replaces" path and "copy the latest request".
- Verify: S1 has no exceptions left; S6 forbids the old cursor; every check
  from steps G to 15 is still green.
- Rollback: revert to the step 15 release, until step 17 drops the
  columns and tables. Rollback cannot undo this: no conversation can go
  back to today's workers, because they and the move-back path are gone,
  and the state that step 15 moved (Redis turn cursors, active Agent
  invocation rows, dispatch records) is not made again. After step 17, fix
  forward only.

### 17. Clean up

- [ ] 17.1 One release after step 16, drop `execution_status`, `run_id`
      and the old tables after a dry run. Step 15 code still selects the
      columns while step 16 deploys.
- [ ] 17.2 Move lasting rules into code, tests and policies. Delete this
      plan. CI keeps running `verification/`, which reads nothing here.
- Verify: every check from steps G to 16 is still green.
- Rollback: a column or table drop cannot be undone; the dry run comes
  first.
