# Tasks

## How To Use This Plan

- Full design first (Decided: P1). Three phases:
  1. Pre-work: step G (the gate), then step 2 (words). Each ships alone and
     rolls back alone. #2556 is not a step: it is a reviewed PR for a live
     bug and lands on its own, ungated. Step 1 is retired.
  2. Build: steps 3 to 13 build the new core beside today's code. It is not
     wired to production traffic: entry-point wiring comes in step 15. The conformance tests and the gate run
     against it. A build step changes no production behavior, so its
     rollback is a revert.
  3. Cut over and delete: step 14 points today's readers at the new
     core's rows and ships the shim, step 15 routes every kind through `work()`, step 16 deletes
     today's workers and records, and step 17 deletes this plan.
- Rolling deploy: old and new workers run at the same time. P45 says how
  the cutover stays safe: the stale lease fence and the pin, with no
  reader gate.
- No manual intervention (Decided: P47): every release, revert and
  migration runs through normal CI/CD with zero downtime. No step has an
  operator flag, a count to watch or a command to run once. A release that
  needs earlier state to drain carries a guard migration that fails, so
  CI/CD stops it.
- At the start of step 14, check P45 against current `main`: the two
  paths that erase a lease and today's ingress append.
- Each step adds or extends an integration test through the real worker
  (`policies/testing.md`). Fake only Slack and LLMs.
- A change to a decided rule needs David's OK.
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
      `WorkerLock.tla`, `StopClock.tla`, `Cutover.tla`, `CutoverTree.tla`,
      `CutoverShim.tla`, `DropGuard.tla`, `cfg/`, `checks.txt`, `evidence.txt`
      and `check.sh`. `check.sh` runs every check in `checks.txt` with TLC and
      fails on a changed result. `FINDINGS.md` has the counterexamples.
- [ ] G.1a Model parent and child conversations and the system actor.
- [ ] G.1b Model the adversarial `send`.
- [ ] G.1c Model request-record matching: I5, I6, I9 and I12.
- [ ] G.1d Model tree-stop results: I8, and P35 on the receive clock (P44).
- [ ] G.1e Model sandbox process tags: I13.
- [ ] G.1f Grow the bound toward the P37 target bound. Done for P45 in
      `CutoverShim.tla` (`shim_design`, `shim_abandon`, `shim_long`,
      `shim_stop`, `shim_inv`, `shim_ingress`, `shim_rollback`, `shim_gap`,
      `shim_examples`), `CutoverTree.tla` (`tree_shim`) and `DropGuard.tla`
      (`drop_design`): `maxDuration` and `D(lease)` with the running max and
      the 1,800 s ceiling, the stale lease fence with the tombstone and its
      read order (C11), the heartbeat clear and the takeover that save
      `staleLeaseAcquiredAtMs`, `o1` with no fence, the pin, deploys and reverts
      that change the current row, the move back with the C10 delete, the end
      rule (C12) and the fence on a revert take (C14), the lease-less
      `abandonTurnRecord`, the pending stop, I15 for Agent invocation rows,
      Slack ingress with the shared claim (C5, C6), C7 in the shim's terms, an
      Instant Rollback below step 3 with `freshSinceAtMs` (C13) and the pin
      expiry, and the column-drop guard with `lastSeenAtMs` from invocations,
      the throttle and a revert and a promote again. The P46 drop with the
      repair job is in `errors_design` (L1 to L3). Left: the sweep under the
      fence (a full lock take, root before child); liveness for an append
      after the move; I15 beyond the Agent invocation row; a Slack retry that
      finds a request record but no append; the P37 target bound (2
      conversations, 2 person actors and the system actor, 4 inputs).
      Stale after the simplification pass (the model needs updating; this
      plan is the target): - The lock has no token; the version alone fences (`WorkerLock.tla`
      `TokenOk`). - The fence uses a fixed `D` of 1,800 s: no running max and no lease
      `deploymentId` (`shim_long`). - The margin `M` is 5 min, not a 60 s skew allowance; the drop wait is
      `1 h + 2×D + M + 60 s` (`drop_design`). - The shim ships in step 14, not step 3: a first current-row upsert
      sets `freshSinceAtMs`, and ingress from before step 14 can be in
      flight during a release jump. - The sweep has no TTL refresh.
- [ ] G.1g Run `check.sh` in CI when `packages/junior/verification/**`
      changes, and once a week. A full run of the 76 checks takes about
      5 h 25 min on 4 cores (the sum of wall times in `results.txt`); the
      slowest, the combined `errors_design` liveness check, takes about 2 h.
      The larger G.1f bound runs only in the weekly job. Every worked example
      is an `ex_*` check.
- [x] G.1h Split `send()` in `WorkerLock.tla` into its P32 steps (append,
      `inboxSeq`, `wakeAtMs`, wake-time index, notify), each with a crash
      action (`SEND_STEPS`).
- [x] G.1i Remove the `QUEUE_CAP` drop in `Inc`, so no notify is dropped
      at the bound. The queue has no cap; each send comes from a bounded
      event, so the count stays finite.
- [x] G.1j Add a stall: a live worker's lock expires at any step and it
      keeps running (`LockExpires`, P42 `stall`).
- [x] G.1k Pin a TLC release that cannot be published again in
      `check.sh`: stable v1.7.4 (SHA-256 `936a2620…0e88`). v1.8.0 is a
      prerelease whose jar was replaced (its checksum changed). v1.7.4 has
      no `-dumpTrace json`, so `check.sh` and `trace.py` read TLC's text
      trace.
- [x] G.1l Move the draft-only checks (`priorDraft`, `rev2`, `rev3`,
      `noPause` and the failing cutover variants) out of `checks.txt` into
      `evidence.txt`. Check `errors_design` L1, L2 and L3 in one run. Keep
      `README.md` at the plan head the model checks.
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

- [ ] 3.1 Add lock expiry and version to the conversation row. Take the
      lock with the compare-and-set. Check in and release with the version;
      release sets the expiry to null. All lock times use database `now()`.
- [ ] 3.2 Add `nextRunAtMs`, the one runnable test. Before release, set
      `wakeAtMs` with a compare-and-set on `inboxSeq` and queue a delayed
      notify for it. Release, then read the inbox record again. Never
      release while the turn is `running`.
- [ ] 3.3 `recordSignIn` raises `inboxSeq` and sets `wakeAtMs` to now
      before it notifies.
- [ ] 3.4 A notify that finds a live lock is dropped; the repair job is the
      backstop (P46).
- [ ] 3.5 Emit the lock check-in rate as a metric (`TELEMETRY.md`), the
      input to the P43 switch rule.
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
- [ ] 11.3 Set the `maxAgentDepth` default to 1 (Decided).
- [ ] 11.4 Test: busy child (agents E1), grandchild result (agents E2) and
      a forged result (agents E5).
- Verify: I5 for records, I8 and I9; L1 for children; agent-tree › Same
  actor, Grandchild spawns, Grandchild result after the child's turn ended, Forged result,
  Result wakes an idle parent, Two siblings finish together;
  turn-access › Grandchild result after another person messaged the child;
  traces agents E1, E2, E5 and edges E2; the guardian cases.

### 12. Plugin-started agents

- [ ] 12.1 Plugin-started runs use `work()`. An Automation run has
      `replyTo: stored` and `outcomes` on its record; `finishTurn` delivers
      its one result to each outcome (P18). Plugins read the computed view.
      Automation run rows compute their status after dispatch from the
      request record; only the claim, `automationVersion` and the statuses
      from before dispatch stay stored (P18).
- [ ] 12.2 Test: an Automation run through `finishTurn` (edges E1).
- Verify: L1 for plugin-started runs; plugin-started-agents › Draft stays
  in the web view, Result from the final response, Result from the tool
  call, No action, Misconfigured, Empty outcomes, Result already sent;
  trace edges E1.

### 13. Credentials and the sandbox pass

- [ ] 13.1 Add `credentialsForTurn` and `bindSubject` (signature covers the
      run). Check at the start of every attempt (start, resume, restart,
      continuation), and nowhere else (P17).
- [ ] 13.2 One pass per turn on the turn row. The proxy checks it against
      the open turn, `running`, with a live lock. No-credentials policy at
      finish and at the listed pauses. Kill user processes when the actor
      or access changes.
- [ ] 13.3 Document one sandbox per conversation in the user docs, on the
      sandbox section of `packages/docs` (`concepts/security-and-authority.md`):
      a file that one person's turn leaves in the sandbox can run in a
      later person's turn with that person's access. Short and factual, no
      exploit steps (P36).
- [ ] 13.4 Test: background process after the turn (access E5).
- Verify: I5 for credentials and I13; S2; turn-access › Background process
  after the turn, Pass from an older turn, Docs state the shared-file
  limit; traces access E4, E5.

## Cut Over And Delete

### 14. Cutover readers and the shim

- [ ] 14.1 Readers (`listAgents`, the dashboard, reporting, result handling
      and the plugin view) read turn rows and request records for a
      new-core conversation, else today's rows.
- [ ] 14.2 The shim reader (P45), in `chat/cutover/` and today's worker
      modules. It changes no user-visible behavior, because no conversation
      is new core yet. Add the `core` field on the conversation row; a child
      inherits its root's `core`. Today's workers read it and refuse
      `core = new`: they ack and send nothing. The heartbeat clear of an
      expired lease and a take over an expired lease first save the old
      `acquiredAtMs` as `staleLeaseAcquiredAtMs` (the larger value) on the
      SQL row. Each invocation that runs work first upserts its deployment
      row (`deploymentId`, `capabilities`, `lastSeenAtMs`; at most once a
      minute). Every ingress path first adds the id to
      `execution.inboundMessageIds` in one conversation mutation, before it
      reads `core`; only the add that wins goes on (C5, C6). Each new Agent
      invocation row stores the id of the parent turn that created it, and
      the request record id when the parent has one (I15). The heartbeat
      cron upserts the current-deployment row (`deploymentId`,
      `capabilities`, `currentSinceAtMs`, `freshSinceAtMs`, `updatedAtMs`).
      It sets `freshSinceAtMs` on the first upsert and after any missed cron
      run: when the old `updatedAtMs` is more than one cron interval plus
      jitter old, with the jitter allowance below one interval (C13).
- [ ] 14.3 The move back (P45). When the current deployment lacks
      `new_core`, a take that finds `core = new` and no pin first passes the
      stale lease fence and pins, in the C11 read order (C14). Then it
      deletes each Redis turn cursor that has a turn row and each waiting
      input that has a request record (C10). An open turn row whose cursor
      already has an end status ends through `finishTurn` with that end
      status, and nothing runs it (C12). Then it runs the new core's
      `work()` until the conversation has no open turn and no open record,
      clears the pin and sets `core = old`. Today's timer job notifies each
      new-core conversation whose `wakeAtMs` has passed. No flag turns this
      on.
- [ ] 14.4 Test: a take over an expired lease and a heartbeat clear each
      save `staleLeaseAcquiredAtMs`; a refusal sends no message; a new
      invocation row has its parent turn id; an invocation writes its
      deployment row at most once a minute; the first current-row upsert
      and a rollback shorter than 3 minutes (one missed cron run) each set
      `freshSinceAtMs`; after a revert, a paused new-core turn finishes and
      moves back with no new input; no move back while the current
      deployment has `new_core`; after a revert, input in the new core's
      inbox does not run while today's lease holder runs, and runs after
      the fence passes and the take pins; a move back after a crashed move
      leaves no Redis cursor or waiting input that has a turn row or
      request record; the move back runs no turn whose cursor
      `abandonTurnRecord` ended.
- Verify: every check from steps G to 13; `shim_design` (`safety`,
  `oneCore`, with C12 and C14); turn-lifecycle › Old worker
  refuses a new-core conversation, Revert moves conversations back, Move
  back after a crashed move, Move back after an abandoned half-moved turn,
  Revert take waits out today's lease.
- Rollback: revert. No conversation is new core yet.

### 15. Cutover release

- [ ] 15.1 Every kind runs through `work()`: Slack, web and ACP, events,
      Automations, plugin-started agents, child agents and the CLI
      (`pnpm cli -- chat` uses core ingress and runs `work()` locally).
      Core ingress, `askChild` and `startPluginAgent` mint records. Slack
      stop, dashboard stop, ACP stop and thread opt-out call `stop()`.
      Until the current row has `new_core` (15.4), input takes today's
      path, as in the step 14 release. Core ingress makes the same shared
      claim as today's ingress (14.2) before its SQL insert.
- [ ] 15.2 Every new-core lock take that finds today's state moves it
      (P45): it pins today's lease (`MAX_SAFE_INTEGER`, fixed token) and
      refreshes the record's 7-day TTL, then in one locked step moves an
      open Redis turn cursor into a turn row keyed by its turn id, today's
      waiting inbox input into inbox entries with request records (unique
      on `(conversationId, inboundMessageId)`, `inboundMessageIds`
      copied, admission run again), and Slack `activeTurnId` and
      `pendingAuth` into the turn row. Active Agent invocation rows and
      dispatch records move only when the child passes the stale lease
      fence and is pinned, or is new-core (C7); a
      live `replaced` row is first reported to its parent as a `failed`
      result. A repeat after a crash inserts nothing new and only deletes.
      A repeat that finds a cursor with an end status and an open turn row
      ends that row through `finishTurn` with the same end status and does
      not run it. Today's stop request (`conversationStopKey`) becomes
      `stopAtMs` at the move's database `now()`: inputs in its
      `inboundMessageIds` get a `receivedAtMs` before it, others after.
- [ ] 15.3 Moved authority (P45, I15): verify each old subject with today's
      `verify*` check, then `bindSubject` with the P45 mapping table, then
      `credentialsForTurn` at the first attempt after the move. A moved Agent invocation row
      is trusted only when it stores its parent turn id (14.2) and its actor and
      subject match that turn or request record. Every other active row closes
      with a `failed` result to the parent. The move never looks up the parent's
      latest invocation. Add a kind and scope for a DM plugin dispatch to
      `interfaces/access.md`, or close those records. A missing actor or a
      failed check closes the turn or record with a visible note. A system
      actor's `pendingAuth` ends `blocked`; a person's old sign-in link expires
      or is bound to the turn id.
- [ ] 15.4 The stale lease fence (P45): the move takes an expired today's
      lease only after the larger of `acquiredAtMs` and
      `staleLeaseAcquiredAtMs`, plus `D` (1,800 s) and `M` (5 min), else it
      sets `wakeAtMs` to that time. With no lease and no recent
      `staleLeaseAcquiredAtMs`, it moves at once, except in the first
      2,100 s after `freshSinceAtMs`. It reads the lease, then the
      tombstone, in the conversation mutation that writes the pin (C11).
      A missing current row, or one with `updatedAtMs` more than 3
      minutes old, is current for no deployment. A
      new-core worker on a deployment that is not the current row takes
      no lock and acks; the repair job on the current deployment runs the
      conversation. This release adds `new_core` to its capabilities. No
      operator switch.
- [ ] 15.5 The background sweep (P45): the repair job moves each
      conversation in today's Redis conversation indexes that still holds
      today's state, only through a full new-core lock take (the
      compare-and-set, the fence and its read order, the pin, the
      authority checks), and never a child before its root has
      `core = new`. It notifies the parent of each active Agent
      invocation row on an old-core conversation. When a sweep finds nothing (wake fields alone do not count) and
      no deployment row without `new_core` has `lastSeenAtMs` in the last
      7 days, it saves `oldStateDrainedAtMs`.
- [ ] 15.6 Put the fence, move, pin, move back and sweep in one feature
      directory, `chat/cutover/`, so step 16 deletes it whole.
- [ ] 15.7 Test: a conversation with an open Redis turn cursor and a running
      child agent moves on its first lock take; a repeat after a crash in the
      move mints no second record; a Slack retry after the move is a duplicate;
      a moved turn whose subject fails its check is closed; an invocation row
      with no parent turn id is closed with a `failed` result; no move before
      the fence passes for an expired or cleared lease (`D + M` after the later
      take); no new-core lock take while the current row is missing or stale;
      an abandoned half-moved turn ends without a run; a pending stop stops the
      moved turn; a worker on a deployment that is not current takes no lock; the
      sweep moves an idle conversation with no new input.
- Verify: the gate is green, with I15; `shim_design` (`safety`,
  `oneCore`), `shim_abandon`, `shim_long`, `shim_stop` and `shim_inv`
  (`safety`), `shim_ingress`, `shim_rollback` (`onlyWindowGap`),
  `tree_shim` and `drop_design` (`noReadAfterDrop`) hold, and `shim_gap`
  and `shim_rollback` `safety` fail only as the accepted give-up and
  window; I1 holds across the move; turn-lifecycle ›
  Cutover from the old turn cursor, Expired lease waits out the old
  worker, Cleared lease waits out the old worker, New-core worker on a
  deployment that is not current, Pin outlives the move, Inbox move after
  a crash, Moved authority not verified, Agent invocation row without its
  creating record, Tombstone read after the lease, Fence ignores the
  deployment's maxDuration, Release jump to the cutover, Abandoned
  half-moved turn, Pending stop moves with the conversation, Instant Rollback below
  step 14, Short rollback below step 14, Repair job moves leftover state;
  conversation-inbox › Duplicate CLI input.
- Rollback (P45): a revert deploy. Moves stop within about a minute, when
  the cron updates the current row. Each new-core conversation finishes
  its open work and moves back by itself (14.3).

### 16. Delete release

- [ ] 16.1 A guard migration fails unless `oldStateDrainedAtMs` is set and
      no active Agent invocation row is on an old-core conversation (P45
      delete guard). `junior upgrade` runs it before the deploy, so CI/CD
      stops the release while old state remains; the next deploy checks
      again.
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
- [ ] 16.5 Delete the shim: `chat/cutover/` (fence, move, pin, move back,
      sweep) and every `core` check and tombstone write. Keep
      the current row and deployment row writers for step 17's guard, and
      the shared ingress claim (C5, C6) for ingress in flight on a step 15
      deployment. This release adds `old_core_deleted` to its capabilities.
- [ ] 16.6 Delete the copies: every reader and writer of the copied
      `execution_status` and `run_id` columns (P3), the second
      status-to-end mapping, the step 14 fallback reads, the
      post-then-commit guard, the opt-out-only tree walk and the stop
      variants per entry point, the writers of the Automation run row
      columns that are now computed (`status` after dispatch,
      `startedAtMs`, `completedAtMs`, `errorMessage`, `resultMessageTs`),
      the other credential builders, the pass
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

- [ ] 17.1 Drop `execution_status`, `run_id`, the computed Automation run
      row columns (16.6), the `core` column, `staleLeaseAcquiredAtMs`,
      `oldStateDrainedAtMs`, the current row, the deployment rows and the old
      tables (with the Agent invocation table and its parent turn id and request
      record id) in one migration. Delete their writers and the shared ingress
      claim. It first checks that the current row has `old_core_deleted` and
      that every deployment row without it has `lastSeenAtMs` at least
      `1 h + 2×D + M + 60 s` (2 h 6 min) old (P45 column-drop guard), since
      code from steps 14 to 15 still selects the columns, and fails otherwise, so
      CI/CD stops the release. The schema checks
      (`pnpm migration-metadata:check`) run on it in CI.
- [ ] 17.2 Move lasting rules into code, tests and policies. Delete this
      plan. CI keeps running `packages/junior/verification/`, which reads
      nothing here. From then on, its scenario-id list is the only source
      for the trace check (P40).
- [ ] 17.3 Test: the drop migration fails until no deployment without
      `old_core_deleted` has been seen for the guard time, including one
      that was current for less than one cron interval.
- Verify: every check from steps G to 16 is still green; turn-lifecycle ›
  Column drop blocked while older code is live, Revert and promote within
  one cron interval.
- Rollback: a column or table drop cannot be undone. The guard checks
  first; after the drop, fix forward only.
