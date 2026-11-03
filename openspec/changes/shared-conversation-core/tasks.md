# Tasks

## How To Use This Plan

- Each step ships alone, leaves `main` correct, and deletes the copy it
  replaces. A step that only adds a layer is not done.
- At the start of each step, check this plan against current `main`.
- Each step adds or extends an integration test through the real worker
  (`policies/testing.md`). Fake only Slack and LLMs.
- Each step is safe under a rolling deploy: old and new workers run at the
  same time. Readers ship before writers.
- "Needs" lists the decisions (`design.md`, Decisions Needed) that must be
  signed off before the step starts. A change to a decided rule needs
  David's OK.
- Steps 3 to 11 fix today's workers. Steps 12 and 13 move child agents and
  plugin-started agents onto the one worker (P1).

## Steps

### 1. Retried prompt keeps its author

- [ ] 1.1 Land #2556 (still open). A retried turn does not change the author
      or the sender check of a saved message.

### 2. Words

- [ ] 2.1 Change `TERMINOLOGY.md` to the words in `design.md` (P16).
- [ ] 2.2 Keep the old names in its mapping table until their code changes.

### 3. One writer for the SQL status columns

- [ ] 3.1 Only turn start and the turn end write `execution_status` and
      `run_id`.
- [ ] 3.2 Delete: the second writer in `recordExecution`.

### 4. Lock version and a finished turn that stays finished

Needs: P2, P5.

- [ ] 4.1 Add the lock version counter on the SQL conversation row. Raise it
      when a worker takes the lock.
- [ ] 4.2 Every turn save and history commit checks it in the same write.
      Throw `LockLostError` on an old version.
- [ ] 4.3 Refuse any save to a finished turn.
- [ ] 4.4 Test: a slow worker's save after a new worker took the lock (turn
      E3).
- [ ] 4.5 Delete: the lease check followed by a separate write.

### 5. One `finishTurn`

Needs: P4, P8, P12, P22.

- [ ] 5.1 Add `finishTurn`, resumable through `finishing`. Today's four
      last-try branches call it with a reply target, not a callback.
- [ ] 5.2 The timer job only clears an expired lock and notifies a worker.
      The next worker restarts once or fails the turn.
- [ ] 5.3 Count `errors` and `restarts` per turn. Giving up keeps other
      people's waiting input.
- [ ] 5.4 Write one `turn.terminal` event per turn end.
- [ ] 5.5 Test: retries running out (turn E4) and a dead worker (turn E2).
- [ ] 5.6 Delete: the lost-worker fallback in the timer job and the second
      status-to-end mapping.

### 6. Resumed plugin-started agents honor stop

- [ ] 6.1 A resumed plugin-started agent reads the saved stop.

### 7. The turn row is the only turn status

Needs: P2, P3.

- [ ] 7.1 Add the SQL turn row with one open row per conversation.
      `currentTurn` reads it. Stop and sign-in key by turn id.
- [ ] 7.2 Read the Redis turn cursor as a fallback until its entries expire
      (24 h), then remove the fallback.
- [ ] 7.3 Delete: the Redis turn cursor, Slack `activeTurnId` and
      `pendingAuth`, and the per-turn Redis mutation lock.

### 8. Delivery intents and pause reasons

Needs: P5, P10, P11.

- [ ] 8.1 Save a delivery intent before each post. Post with the delivery id.
      Check `find` before a repeat post.
- [ ] 8.2 Split `retry` into `post_retry` and a restart. Rename `yield` and
      `timeout`.
- [ ] 8.3 Test: two outcomes where the second post fails (edges E1).
- [ ] 8.4 Delete: the post-then-commit guard in each provider turn.

### 9. One credential builder and a sandbox pass per turn

Needs: P17, P28, P29.

- [ ] 9.1 Add `credentialsForTurn`. Check delegated subjects at every start
      and resume.
- [ ] 9.2 Bind the pass to the turn. Revoke it in `finishTurn` and at a
      restart. The proxy checks revocation.
- [ ] 9.3 Save proxy sign-in signals under the pass's turn.
- [ ] 9.4 Document one sandbox per conversation in the user docs.
- [ ] 9.5 Test: a background process after the turn ends (access E4).
- [ ] 9.6 Delete: the other turn credential builders.

### 10. One sign-in supersede rule

Needs: P13, P24.

- [ ] 10.1 Same-person input ends a sign-in wait with a note. Others wait
      until sign-in or expiry. Same for every kind.
- [ ] 10.2 Test: access E1 and E2.
- [ ] 10.3 Delete: the silent web supersede and the Slack "newer sign-in
      replaces" path.

### 11. Top-level stop stops the tree

- [ ] 11.1 Slack stop, dashboard stop, ACP stop and thread opt-out stop the
      tree and mark its open request records `stopped`.
- [ ] 11.2 Test: agents E3.

### 12. Child agents on the one worker

Needs: P6, P7, P15, P20, P23, P26.

- [ ] 12.1 Add request records. `spawnAgent` and `messageAgent` save one and
      call `send()`.
- [ ] 12.2 Child turns run in `work()`. Results go to the parent inbox at
      `finishTurn`.
- [ ] 12.3 Set `maxAgentDepth` default to 1.
- [ ] 12.4 Report or move live `replaced` requests before the cutover.
- [ ] 12.5 Test: busy child (agents E1), grandchild result (agents E2).
- [ ] 12.6 Delete: the child runner, Agent invocation run statuses,
      `replaced`, `reportNow`, the result sweep and "copy the latest
      request".

### 13. Plugin-started agents on the one worker

Needs: P14, P18, P21.

- [ ] 13.1 A request record replaces the dispatch record. Plugins read the
      computed view.
- [ ] 13.2 Test: an Automation run through `finishTurn`.
- [ ] 13.3 Delete: the dispatch runner, dispatch statuses and the outbox
      sweep.

### 14. The CLI through the inbox

- [ ] 14.1 `pnpm cli -- chat` calls `send()` and runs `work()` locally.
- [ ] 14.2 Delete: the CLI's direct turn path.

### 15. Clean up

Needs: P3.

- [ ] 15.1 Drop `execution_status` and `run_id` one release after no code
      reads them.
- [ ] 15.2 Remove old Redis keys after they expire.
- [ ] 15.3 Move lasting rules into code, tests and policies. Delete this
      plan.
