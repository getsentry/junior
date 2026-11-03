# Tasks

## How To Use This Plan

- Full design first (Decided: P1). Three phases:
  1. Pre-work: step G (the gate), then step 2 (words). Each ships alone and
     rolls back alone. #2556 is not a step: it is a reviewed PR for a live
     bug and lands on its own, ungated. Step 1 is retired.
  2. Build: steps 3 to 13 build the new core beside today's code. It is not
     wired to production traffic: entry-point wiring and the check-in
     metric come in step 15. The conformance tests and the gate run
     against it. A build step changes no production behavior, so its
     rollback is a revert.
  3. Cut over and delete: step 14 teaches today's code to read the new
     core, step 15 routes every kind through `work()`, step 16 deletes
     today's workers and records, and step 17 deletes this plan.
- Rolling deploy: old and new workers run at the same time. Readers ship one
  release before writers. A writer's new path turns itself on when the
  deploy record shows no live deployment without its reader (P45). P45 says
  how the cutover stays safe.
- No manual intervention (Decided: P47): every release, revert and
  migration runs through normal CI/CD with zero downtime. No step has an
  operator flag, a count to watch or a command to run once. A release that
  needs earlier state to drain carries a guard migration that fails, so
  CI/CD stops it.
- At the start of each step, check this plan against current `main`.
- Each step adds or extends an integration test through the real worker
  (`policies/testing.md`). Fake only Slack and LLMs.
- "Needs" lists the decisions (`design.md`, Decisions Needed) that must be
  signed off first. A change to a decided rule needs David's OK.
- Gate timing (Decided: P41): step G ships first. With the model complete
  (G.1a–G.1l), it must be green before the cutover release (step 15). A
  build step merges only when the checks its Verify line names are green
  against the new core.
- "Verify" names the invariants (I), liveness properties (L), rules (S),
  traces and scenarios that must be green after the step
  (`specs/verification/spec.md`). A step adds its own; it never removes an
  earlier one.
- Risk: one large cutover, and no smaller-option fixes for today's workers
  before it.

## Pre-Work

### G. Verification gate

- [ ] G.0 Amend `policies/testing.md` to allow one injected `faults` port:
      passed through existing dependency wiring, optional and a no-op when
      absent, never passed in production, with no global, singleton or
      test-only module API. Reason: decided for the verification gate
      (P42).
- [ ] G.0b Amend `policies/serverless-background-work.md` with one rule:
      rollouts and migrations must not require manual intervention and
      must work with CI/CD. Reason: decided as P47.
- [x] G.1 The TLA+ model is in `packages/junior/verification/` (P37, P40):
      `WorkerLock.tla`, `StopClock.tla`, `Cutover.tla`, `cfg/`,
      `checks.txt` and `check.sh`. `check.sh` runs every check in
      `checks.txt` with TLC and fails on a changed result. `FINDINGS.md`
      has the counterexamples.
- [ ] G.1a Model parent and child conversations and the system actor.
- [ ] G.1b Model the adversarial `send`.
- [ ] G.1c Model request-record matching: I5, I6, I9 and I12.
- [ ] G.1d Model tree-stop results: I8, and P35 on the receive clock (P44).
- [ ] G.1e Model sandbox process tags: I13.
- [ ] G.1f Grow the bound toward the P37 target bound. In `Cutover.tla`,
      model the inbox move, a parent with a child, and `o1` with no fence
      (`OldOk(w) == w = "o1" \/ ~OLD_FENCED \/ lease = w`). Replace the
      switch flips with deploys and reverts that change the deploy record,
      and the P45 gate with the drain end: a deployment that is not
      current still gets its own messages until they expire. While moves
      can happen, `o1` cannot take the lease or keep running. Model the
      stale lease fence for a worker with no record, and a new-core worker
      that stops when its deployment is not current. Model the revert and the automatic move back. Add
      I15 (P45): a moved turn or record has the verified old actor and
      subject, or it is closed. Model the P46 drop with the repair job as
      the backstop.
- [ ] G.1g Run `check.sh` in CI when `packages/junior/verification/**`
      changes, and once a week. The larger G.1f bound runs only in the
      weekly job. Every worked example is an `ex_*` check.
- [ ] G.1h Split `send()` in `WorkerLock.tla` into its P32 steps (append,
      `inboxSeq`, `wakeAtMs`, wake-time index, notify), each with a crash
      action.
- [ ] G.1i Replace the `QUEUE_CAP` drop in `Inc` with a state constraint,
      so the bound stops the search instead of dropping a notify.
- [ ] G.1j Add a stall action next to each crash: the worker pauses, its
      lock expires, then it resumes (P42 `stall`).
- [ ] G.1k Pin a TLC release that cannot be published again in
      `check.sh`: stable v1.7.4 (SHA-256 `936a2620…0e88`). v1.8.0 is a
      prerelease whose jar was replaced (its checksum changed). v1.7.4 has
      no `-dumpTrace json`, so `check.sh` and `trace.py` read TLC's text
      trace. Maven Central search finds no `tla2tools` artifact.
- [ ] G.1l Move the draft-only checks (`priorDraft`, `rev2`, `rev3`,
      `noPause` and the failing cutover variants) out of `checks.txt` into
      `FINDINGS.md` as evidence. Check `errors_design` L1, L2 and L3 in one
      run. Keep `README.md` at the plan head the model checks.
- [ ] G.2 Add the scenario-id list and the trace check there. At the gate, a
      scenario may map only to a model invariant or trace. The step that
      builds the behavior adds its test id. The check also matches each
      fault point name with a model crash action, both ways.
- [ ] G.3 Add the conformance harness (P38) on the integration harness,
      with the `faults` port (P42): one point per `Crash_<Point>` action in
      `WorkerLock.tla` that the design has (17 of the 20, plus the G.1h
      `send()` steps), each with `kill` and `stall`, and a two-worker suite
      on real Postgres for the lock compare-and-set. It runs on every PR,
      against the new core as each build step lands.
- [ ] G.4 Add the structural check runner. Each rule lands with the step
      that makes it true.
- Verify: the model holds I1–I15 and L1–L3 within the bound; every scenario
  maps. Step G is not green until G.1a to G.1l are done, and it is green
  before the cutover release (step 15).
- Rollback: CI and test wiring only. Remove the jobs.

### 2. Words

- [ ] 2.1 Change `TERMINOLOGY.md` to the words in `design.md` (P16).
- Verify: docs only.
- Rollback: revert.

## Build The New Core

### 3. SQL worker lock, lock version and wake time

- [ ] 3.1 Add lock token, expiry and version to the conversation row. Take
      the lock with the compare-and-set. Check in and release with the
      token and version. All lock times use database `now()`.
- [ ] 3.2 Add `nextRunAtMs`, the one runnable test. Before release, set
      `wakeAtMs` with a compare-and-set on `inboxSeq` and queue a delayed
      notify for it. Release, then read the inbox record again. Never
      release while the turn is `running`.
- [ ] 3.3 `recordSignIn` raises `inboxSeq` and sets `wakeAtMs` to now
      before it notifies.
- [ ] 3.4 A notify that finds a live lock is dropped; the repair job is the
      backstop (P46).
- [ ] 3.5 Each deployment writes its deploy record (P45): deployment id,
      release, capabilities, its `maxDuration`, `firstSeenAtMs`,
      `lastSeenAtMs` from each invocation that runs work (15 s cadence),
      `lastCronAtMs` from the heartbeat cron, and `lastPublishAtMs`
      before a queue send (60 s cadence; a failed write fails the send),
      all with database `now()`. One function computes the current
      deployment and each drain end. It changes no user-visible behavior.
      From here on, every deployment, including a revert, is visible to
      the cutover gate. Test: a deployment that is quiet for 10 minutes
      after its last publish is still live.
- [ ] 3.6 Test: a slow worker after a takeover cannot check in (turn E3); a
      message while the lock is held (turn E7); a sign-in while the lock is
      held.
- Verify: I3 for lock take and check-in; L3 without repair fairness; S5 for
  lock writes; turn-lifecycle › Slow worker save; conversation-inbox ›
  Message while the lock is held; traces turn E3, E7, access E2 and
  `wakeLive_design l3_pausedResumedNoRepair`; L3 with the repair job after
  a lost notify (P46).

### 4. Turn rows

- [ ] 4.1 Add the turn table (with `oldestInputReceivedAtMs`) and the
      one-open index. `startTurn` in one transaction, fenced
      `saveCheckpoint`, a finished guard.
- [ ] 4.2 Every turn state: `finishing`, `error_retry`, the five pause
      reasons and the stop time.
- [ ] 4.3 Test: a late save to a finished turn is refused; a redelivered
      prompt (turn E1).
- Verify: I1, I2, I3 and I12; S6; turn-lifecycle › Second start, Late save,
  Crash between commit and inbox removal; trace turn E1.

### 5. Request records and `send()`

- [ ] 5.1 `createRequest` mints the record, then binds the subject (P17).
      The record is unique on `(conversationId, inboundMessageId)`.
- [ ] 5.2 `send()` appends, raises `inboxSeq`, sets `wakeAtMs` and
      notifies. Duplicates by message id.
- [ ] 5.3 Add `VerifiedPersonActor`, the agent-message type, the import
      boundary for `createRequest` and `send`, and their runtime asserts.
- [ ] 5.4 Test: a mismatched record (inbox E5).
- Verify: I9; S3 and S4; conversation-inbox › Message points at another
  record, Missing record, Provider retry, Copy while waiting; traces inbox
  E1 and E5.

### 6. `work()`

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

- [ ] 7.1 Give each response a fixed delivery id. Before each post, save a
      checkpoint that commits the response to history and records the
      intent with its text. Check `find` before a repeat post. Send the
      saved text.
- [ ] 7.2 The split `retry` pause and the renamed `yield` and `timeout`.
- [ ] 7.3 Test: two outcomes, second fails (edges E1).
- Verify: I7; turn-lifecycle › Two outcomes, second fails and Restart after
  an intent; trace edges E1; crash point "provider accepted, reply lost".

### 8. `finishTurn()`

- [ ] 8.1 Add `finishTurn` (resumable through `finishing`, using step 7's
      delivery ids). The reply target is data, with no branch on kind.
- [ ] 8.2 Errors pause `error_retry`. A turn is lost only when `running`
      under an expired lock. Its one restart counts one error; one failure
      counts once (P4). An error before `startTurn` commits counts a
      delivery attempt, not a turn error (P22). The timer job only
      notifies a worker.
- [ ] 8.3 Delivery attempts and backoff while finishing. A permanent
      provider error fails the delivery at once.
- [ ] 8.4 Write one `turn.terminal` event per turn end.
- [ ] 8.5 Test: dead worker (turn E2), retries running out (turn E4) and
      stuck delivery (turn E6).
- Verify: I2, I4 and S1; L2; turn-lifecycle › Crash during finish, Retries
  run out, An error is not a lost worker, Lost twice, Failures before the
  turn started, Error message cannot be posted; traces turn E2, E4, E6.

### 9. Stop

- [ ] 9.1 `stop()` saves its database `now()` as the stop time on
      the conversation and every conversation below it, and notifies each
      worker.
- [ ] 9.2 A turn is under the stop when its oldest taken-in input is older
      than the stop time. `startTurn` and joins refuse older input. Every
      fenced save and intent save of a turn under the stop refuses.
      `finishTurn(stopped)` puts newer taken-in input back in the inbox.
- [ ] 9.3 Stamp every input at inbox append, and core-minted input and
      records in their own transaction, with database `now()` (P44).
- [ ] 9.4 Test: top-level stop of a tree (agents E3); stop of a paused
      plugin-started agent.
- Verify: I8, I10, I11 (with joins) and I14; L1 under stop; turn-stop ›
  Stop races a turn start, Turn started after the click, Older input tries
  to join, Newer input joined before the stop, Stop during a pause; traces
  turn E5, agents E3 and E4, and the `stop_receive_*` checks; turn-stop › Late
  result after a tree stop, Late result after stopAgent, Result in flight
  at the stop, Dashboard stop of a child, Slack message received late.

### 10. Sign-in

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

- [ ] 12.1 Plugin-started runs use `work()`. An Automation run has
      `replyTo: stored` and `outcomes` on its record; `finishTurn` delivers
      its one result to each outcome (P18). Plugins read the computed view.
- [ ] 12.2 Test: an Automation run through `finishTurn` (edges E1).
- Verify: L1 for plugin-started runs; plugin-started-agents › Draft stays
  in the web view, Result from the final response, Result from the tool
  call, No action, Misconfigured, Empty outcomes, Result already sent;
  trace edges E1.

### 13. Credentials and the sandbox pass

- [ ] 13.1 Add `credentialsForTurn` and `bindSubject` (signature covers the
      run). Check at every start and resume.
- [ ] 13.2 One pass per turn on the turn row. The proxy checks it against
      the open turn, `running`, with a live lock. No-credentials policy at
      finish and at the listed pauses. Kill user processes when the actor
      or access changes.
- [ ] 13.3 Test: background process after the turn (access E5).
- Verify: I5 for credentials and I13; S2; turn-access › Background process
  after the turn, Pass from an older turn; traces access E4, E5.

## Cut Over And Delete

### 14. Cutover reader release

- [ ] 14.1 Add the `core` owner field to the conversation row (P45). The
      root conversation decides it, and a child inherits it. Today's
      workers read `core` and refuse a conversation that the new core
      owns. They read `core` without taking a pinned lease. A refusal
      acks and sends nothing, so it does not busy-defer on the pin.
- [ ] 14.2 Today's turn cursor writes check the Redis lease token, not
      only the per-turn mutation lock (P45, C3).
- [ ] 14.3 Readers (`listAgents`, the dashboard, reporting, result handling
      and the plugin view) read turn rows and request records for a
      new-core conversation, else today's rows.
- [ ] 14.4 The automatic move back (P45 revert): when no deployment with
      `new_core` is current or live by its drain end, a lock take on a new-core conversation
      runs the new core's `work()` until the conversation has no open turn
      and no open record, then clears the pin and sets `core = old`.
      Today's timer job notifies each new-core conversation whose
      `wakeAtMs` has passed. No flag turns this on.
- [ ] 14.5 The deploy record of this release has `reader`.
- [ ] 14.6 Test: an old worker refuses a new-core conversation; a cursor
      write after its lease expired is refused; after a revert, a paused
      new-core turn finishes and moves back with no new input; no move back
      while a `new_core` deployment is live.
- Verify: every check from steps G to 13; `cutover_oldFenced safety`;
  turn-lifecycle › Old worker refuses a new-core conversation, Revert moves
  conversations back.
- Rollback: revert. No conversation is new core yet.

### 15. Cutover release

- [ ] 15.1 Every kind runs through `work()`: Slack, web and ACP, events,
      Automations, plugin-started agents, child agents and the CLI
      (`pnpm cli -- chat` uses core ingress and runs `work()` locally).
      Core ingress, `askChild` and `startPluginAgent` mint records. Slack
      stop, dashboard stop, ACP stop and thread opt-out call `stop()`.
      Until the gate opens (15.4), input takes today's path, as in the
      step 14 release.
- [ ] 15.2 Every new-core lock take that finds today's state moves it
      (P45): it pins today's lease (`MAX_SAFE_INTEGER`, fixed token) and
      refreshes the record's 7-day TTL, then in one locked step moves an
      open Redis turn cursor into a turn row keyed by its turn id, today's
      waiting inbox input into inbox entries with request records (unique
      on `(conversationId, inboundMessageId)`, `inboundMessageIds`
      copied, admission run again), and Slack `activeTurnId` and
      `pendingAuth` into the turn row. Active Agent invocation rows and
      dispatch records move only when the child is new-core or idle; a
      live `replaced` row is first reported to its parent as a `failed`
      result. A repeat after a crash inserts nothing new and only deletes.
- [ ] 15.3 Moved authority (P45, I15): verify each old subject with
      today's `verify*` check, then `bindSubject` with the P45 mapping
      table, then `credentialsForTurn` before the first resume. A moved
      Agent invocation row takes its actor from its creating record
      through `onBehalfOf`. Add a kind and scope for a DM plugin dispatch
      to `interfaces/access.md`, or close those records. A missing actor or
      a failed check closes the turn or record with a visible note. A
      system actor's `pendingAuth` ends `blocked`; a person's old sign-in
      link expires or is bound to the turn id.
- [ ] 15.4 The automatic gate (P45): a new-core worker moves a
      conversation only when its deployment is current (newest
      `lastCronAtMs`) and no deployment without `reader` is live by its
      drain end. The move takes an expired today's lease only after
      `acquiredAtMs + maxDuration + 60 s`, else it sets `wakeAtMs` to that
      time (stale lease fence). A new-core worker on a deployment that is
      not current takes no lock and sends nothing; it acks, and the repair
      job on the current deployment runs the conversation. The deploy
      record of this release has `new_core`. No operator switch.
- [ ] 15.5 The background sweep (P45): the repair job runs the same move
      on each conversation in today's Redis conversation indexes that
      still holds today's state, and notifies the parent of each active
      Agent invocation row on an old-core conversation. When a sweep finds
      nothing (wake fields alone do not count) and this release has been
      current for 7 days, it saves `oldStateDrainedAtMs`.
- [ ] 15.6 Put the gate, move, pin, move back and sweep in one feature
      directory, `chat/cutover/`, so step 16 deletes it whole.
- [ ] 15.7 Set the `maxAgentDepth` default to 1 (Decided).
- [ ] 15.8 Emit the lock check-in rate as a metric (`TELEMETRY.md`), the
      input to the P43 switch rule.
- [ ] 15.9 Document one sandbox per conversation in the user docs, on the
      sandbox section of `packages/docs` (`concepts/security-and-authority.md`):
      a file that one person's turn leaves in the sandbox can run in a
      later person's turn with that person's access. Short and factual, no
      exploit steps (P36).
- [ ] 15.10 Test: a conversation with an open Redis turn cursor and a
      running child agent moves on its first lock take; a repeat after a
      crash in the move mints no second record; a Slack retry after the
      move is a duplicate; a moved turn whose subject fails its check is
      closed; no move while a deployment without `reader` is live by its
      drain end, even after 10 quiet minutes; no move before
      `acquiredAtMs + maxDuration + 60 s` of an expired lease; a worker on
      a deployment that is not current takes no lock; the sweep moves an
      idle conversation with no new input.
- Verify: the gate is green, with I15; the G.1f cutover checks
  (`safety`, `noDuplicateTurn`, I15) with `o1` unfenced, the deploy gate
  and the revert; I1 holds across the move; turn-lifecycle › Cutover from
  the old turn cursor, Moves wait for the drained deploy, Quiet deployment still live, Expired lease from a worker with no record, New-core worker on a deployment that is not current, Pin outlives the
  move, Inbox move after a crash, Moved authority not verified, Repair job
  moves leftover state; agent-tree › Grandchild spawns;
  conversation-inbox › Duplicate CLI input; turn-access › Docs state the
  shared-file limit.
- Rollback (P45): a revert deploy. Moves stop at once. Each new-core
  conversation finishes its open work and moves back by itself (14.4).

### 16. Delete release

- [ ] 16.1 A guard migration fails unless `oldStateDrainedAtMs` is set, no
      deployment without `new_core` is live by its drain end, and no active Agent invocation row
      is on an old-core conversation (P45 delete guard). `junior upgrade`
      runs it before the deploy, so CI/CD stops the release while old
      state remains; the next deploy checks again.
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
- [ ] 16.5 Delete the shim: `chat/cutover/` (gate, move, pin, move back,
      sweep) and every `core` check. The deploy record of this release has
      `old_core_deleted`.
- [ ] 16.6 Delete the copies: every reader and writer of the copied
      `execution_status` and `run_id` columns (P3), the second
      status-to-end mapping, the step 14 fallback reads, the
      post-then-commit guard, the opt-out-only tree walk and the stop
      variants per entry point, the other credential builders, the pass
      that lasts for the sandbox timeout, the silent web supersede, the
      "newer sign-in replaces" path and "copy the latest request".
- [ ] 16.7 Test: the guard migration fails with old state left and passes
      without it.
- Verify: S1 has no exceptions left; S6 forbids the old cursor; every check
  from steps G to 15 is still green; turn-lifecycle › Delete release
  blocked while old state remains.
- Rollback: a revert to the step 15 release works, but nothing moves back.
  No conversation can go back to today's workers, because the move back is
  gone, and the state that step 15 moved (Redis turn cursors, active Agent
  invocation rows, dispatch records) is not made again. After step 17, fix
  forward only.

### 17. Clean up

- [ ] 17.1 Drop `execution_status`, `run_id`, the `core` column and the old
      tables in one migration. It first checks that no deployment
      without `old_core_deleted` is live by its drain end, since step 15
      code still selects the columns, and fails otherwise, so CI/CD stops
      the release. Those deployments are new core, so the wait ends at
      most about 73 minutes after the step 16 release becomes current. The schema
      checks (`pnpm migration-metadata:check`) run on it in CI.
- [ ] 17.2 Move lasting rules into code, tests and policies. Delete this
      plan. CI keeps running `packages/junior/verification/`, which reads
      nothing here. From then on, its scenario-id list is the only source
      for the trace check (P40).
- [ ] 17.3 Test: the drop migration fails while a deployment without
      `old_core_deleted` is live.
- Verify: every check from steps G to 16 is still green; turn-lifecycle ›
  Column drop blocked while older code is live.
- Rollback: a column or table drop cannot be undone. The guard checks
  first; after the drop, fix forward only.
