# Interfaces: Worker Lock, Turns And Finishing

Sketches for review, not final code. Labels follow `../design.md`.

## Worker Lock

```ts
/** What a worker holds. The SQL conversation row is the source (P5). */
type WorkerLock = {
  conversationId: ConversationId;
  lockVersion: number;
  expiresAtMs: number;
};

/**
 * One compare-and-set on the conversation row: take the lock when it is
 * free or expired, and raise lockVersion. Undefined when a live lock is
 * held. The version never goes down.
 */
function acquireWorkerLock(
  conversationId: ConversationId,
): Promise<WorkerLock | undefined>;

/** Every 15 s. Matches the version and a live expiry. False: lost. */
function checkIn(lock: WorkerLock): Promise<boolean>;

/**
 * Never called while the turn is running: the pause or finish is saved
 * first, and if that save fails the lock is left to expire (P8). One
 * transaction: lock the conversation row FOR UPDATE (same match as
 * checkIn), read the open turn and the inbox, set wakeAtMs to nextRunAtMs
 * and the expiry to null. send() locks the same row, so no input is missed
 * (P32). After the commit: notify a worker if wakeAtMs <= now, else queue a
 * delayed notify for wakeAtMs.
 */
function releaseWorkerLock(lock: WorkerLock): Promise<void>;

/**
 * Pure. The one runnable test: the earliest time this conversation has
 * work (now, a link expiry, a delivery's nextAttemptAtMs, an event window
 * end), or undefined. work() and releaseWorkerLock both use it.
 */
function nextRunAtMs(
  state: { turn?: TurnRecord; inbox: RequestRecord[] },
  nowMs: number,
): number | undefined;

/** Thrown by any save that does not match the held version and a live expiry. */
type LockLostError = Error & {
  code: "lock_lost";
  conversationId: ConversationId;
  held: number;
};

/** True for a LockLostError. The worker stops and does not retry. */
function isLockLostError(error: unknown): error is LockLostError;
```

## Turn Record

```ts
/** SQL, one row per turn. The only turn status (P2). */
type TurnRecord = {
  turnId: TurnId;
  conversationId: ConversationId;
  /** Request records this turn took in. The first one started it. Each
   * one's turnId is set in the same save (rule 6). */
  requestIds: RequestId[];
  /** From the starting request record. Never changes. */
  actor: Actor;
  credentialSubject?: SignedCredentialSubject;
  source: RequestRecord["source"];
  /** Model profile and reasoning, chosen at start, kept on resume. A child
   * takes it from its ConversationPolicy. */
  route: TurnRoute;
  /** Database now() at startTurn (rule 13). Never compared with stopAtMs. */
  startedAtMs: number;
  /**
   * The oldest receivedAtMs of any input this turn took in, at start or by
   * join. The turn is under the stop when this is older than stopAtMs (P34).
   */
  oldestInputReceivedAtMs: number;
  status: "running" | "paused" | "finishing" | Outcome;
  pause?: TurnPause;
  /** Set with "finishing". finishTurn reads it when it runs again. */
  outcome?: TurnOutcome;
  /**
   * Plain errors (Decided, P4): an error after take-in, a lost-worker
   * restart, a resume that saves nothing new, a mid-turn post failure.
   * Limit 5. One failure counts once.
   */
  errors: number;
  totals: {
    attempts: number;
    toolCalls: number;
    costUsd: number;
    durationMs: number;
  };
  checkpoint: { historySeq: number; boundaryKey: string };
  deliveries: Delivery[];
  /** The one pass for this turn (P36). The proxy compares against it. */
  sandboxPassId?: string;
  /** Lock version of the last save. */
  lockVersion: number;
};

type TurnPause =
  | {
      reason: "continue";
      resumedFrom: string;
      /** Backoff after an error or a failed post. Then the sandbox has
       * no credentials until the resume (P36). */
      nextAttemptAtMs?: number;
    }
  | { reason: "sign_in"; provider: string; linkExpiresAtMs: number };

type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; reason: FailReason; errorText: string; eventId?: string }
  | { kind: "blocked"; reason: string }
  | {
      kind: "stopped";
      by: "person" | "parent" | "tree" | "superseded" | "sign_in_expired";
      note?: string;
    };

type FailReason =
  | "error" // the fifth plain error (P4), or a mid-turn delivery out of attempts
  | "limit" // attempts, tool calls or cost; first try
  | "input_dropped"; // its input hit 5 delivery attempts (closing turn)

/** One response to one reply target. */
type Delivery = {
  deliveryId: string; // turnId + response index + target
  target: ReplyTarget;
  /** Saved with the intent. A restart sends this text again (P5). */
  body: ResponseBody;
  state: "intended" | "sent" | "failed";
  attempts: number;
  nextAttemptAtMs?: number;
  providerMessageId?: string;
};
```

## Current Turn And Saves

```ts
/**
 * The conversation's open turn, if any. This is #2567's currentTurnId: the
 * one open row, enforced by a partial unique index (P2).
 */
function currentTurn(
  conversationId: ConversationId,
): Promise<TurnRecord | undefined>;

/**
 * One transaction: check the lock, check the stop time, create the turn row
 * with its requestIds, set each record's turnId (which takes it out of the
 * inbox), and commit the prompt to history. Refuses input older than the
 * stop time. Reads actor, access, source and route from the first record,
 * never from text.
 */
function startTurn(
  lock: WorkerLock,
  batch: RequestRecord[],
): Promise<TurnRecord>;

/**
 * One transaction: check the lock and the stop time, append history,
 * update the turn row, add takeIn request ids and set their turnId. The
 * only history write. Throws LockLostError, or StoppedError when the turn
 * is under the stop. A takeIn refuses input older than stopAtMs, like
 * startTurn (P34).
 */
function saveCheckpoint(
  lock: WorkerLock,
  turn: TurnRecord,
  change: {
    history: HistoryItem[];
    takeIn?: RequestRecord[];
    turn: Partial<TurnRecord>;
  },
): Promise<TurnRecord>;
```

Take-in is part of the save, so no crash leaves a taken record in the
inbox (E1).

## Worker

```ts
/**
 * The only worker. Every kind uses it. Takes the lock, then does the first
 * that applies:
 * 1. open turn "finishing": run finishTurn again with the saved outcome;
 * 2. the open turn is under the stop (oldestInputReceivedAtMs older than
 *    stopAtMs): finishTurn(stopped);
 * 3. open turn "running": the last worker was lost (P8). Restart from the
 *    checkpoint, counting one error, or finishTurn(failed: error) at the
 *    limit (P4);
 * 4. open turn "paused": resume it, or handle sign-in (access.md);
 * 5. no open turn: run selectTurnInput on the inbox. Close dropped or
 *    stop-cut input with closeInput. Then startTurn.
 * Then releaseWorkerLock, which re-checks for work.
 */
function work(conversationId: ConversationId): Promise<void>;
```

## Delivery, Finishing And Closing

```ts
/**
 * Send one body to each distinct reply target of the turn's records that
 * takes it: a location takes each response, a parent or destination only
 * the result (edges.md). With no reply target, history is the delivery.
 * Checks in, then saves a checkpoint
 * that commits the response to history and records the intent with its
 * delivery id and text (fenced, refused under a stop). Posts, then saves
 * the provider message id. Uses replyTargets[target.kind] (edges.md); no
 * branch on kind here.
 */
function deliver(
  lock: WorkerLock,
  turn: TurnRecord,
  body: ResponseBody,
): Promise<void>;

/**
 * The only way a turn ends, and the only writer of request status.
 * Resumable through "finishing":
 * 1. save "finishing" and the outcome (fenced);
 * 2. send the error message or ending note to each location, and the one
 *    result to each parent and destination (P18), with fixed delivery ids;
 *    retry with backoff up to 5 attempts, or fail at once on a permanent
 *    provider error (P33). A result to a parent is a send() after the
 *    save in step 1 commits, keyed by its delivery id (P26);
 * 3. move each taken-in record from open to answered or stopped
 *    (WHERE status = 'open'). For finishTurn(stopped), input not older
 *    than stopAtMs goes back in the inbox: its record stays open and its
 *    turnId is cleared (P34);
 * 4. apply the no-credentials sandbox policy (P36);
 * 5. save the finished status and write one turn.terminal event.
 */
function finishTurn(
  lock: WorkerLock,
  turn: TurnRecord,
  outcome: TurnOutcome,
): Promise<void>;

/**
 * A closing turn (P30): startTurn and finishTurn in one locked step, with
 * no agent. Records input that will not run.
 */
function closeInput(
  lock: WorkerLock,
  batch: RequestRecord[],
  outcome: TurnOutcome,
): Promise<void>;
```

## Stop

```ts
/**
 * Save stopAtMs = database now() of this transaction (P44), and stopBy,
 * on the conversation and on every conversation below it, then notify each
 * worker (P34). Writes no turn row
 * and no request record (rule 7). A top-level stop is always a tree stop
 * (Decided). Input from a person older than the stop is kept in history as
 * "not run".
 */
function stop(
  conversationId: ConversationId,
  by: StopBy,
): Promise<{ stopped: ConversationId[] }>;

type StopBy =
  | { kind: "person"; actor: PersonActor } // Slack stop, dashboard, ACP
  | { kind: "opt_out"; actor: PersonActor } // Slack thread opt-out
  | { kind: "stop_agent"; parentConversationId: ConversationId }; // no result
```

`finishTurn` in a stopped child sends its parent a `stopped` result unless
the stop was explicit for the parent: `stopBy` is `stop_agent`, or the
parent's own stop time is after the record's `receivedAtMs` (a tree stop).
Then the outcome is recorded on the asked record and no turn starts (P35,
Decided). Both stamps are database `now()` (P44).

## Examples

### E1. Redelivered prompt

Before: inbox `[req_1]`. No open turn. Lock version 6.

1. W1 takes the lock (v7). `startTurn` creates T1 with `requestIds:
[req_1]`, sets `req_1.turnId`, and commits the prompt, in one
   transaction.
2. W1 dies.
3. The lock expires. The queue redelivers. W2 takes the lock (v8).
4. `work()` finds T1 `running` (case 3). `req_1` has T1 as its `turnId`,
   so it is not in the inbox.
5. W2 restarts T1 from its checkpoint: `errors: 1` (P4).

After: one copy of the prompt in history. The sender check does not run
again on a saved message.

### E2. Dead worker

Before: T1 `running`, lock v7, last checkpoint at 12:00:00.

1. W1 checks in at 12:00:10 and dies at 12:00:20.
2. At 12:01:40 the lock is expired. On its next pass, the repair job sees a
   `running` turn with an expired lock and notifies a worker. It writes
   nothing.
3. W2's compare-and-set takes the lock (v8). T1 is `running`: lost.
   `errors: 1`. W2 continues from the 12:00:00 checkpoint.
4. A delivery saved as `intended` between 12:00:00 and 12:00:20 is sent
   again from its saved text, after `find` shows it did not land.

If W2 also dies, the next worker restarts T1 again with `errors: 2`. A
worker that finds a lost T1 at `errors: 4` calls `finishTurn(failed: error)`,
because the restart would be the fifth error.

### E3. Slow worker refused by the lock version

Before: W1 holds v7 and runs T1.

1. W1 stalls and misses its check-ins for 90 s.
2. W2's compare-and-set matches (expired): v8.
3. W1 wakes and calls `saveCheckpoint`. The transaction's row check needs
   v7; the row has v8. `LockLostError`. Nothing is saved.
4. Had W1 tried to post, its check-in and its intent save fail the same way.

A Redis expiry cannot reset v8: the counter lives on the SQL row.

### E4. Error retries, then retries running out

Before: T1 for A took in `req_a1`. The inbox has `b1` (B) and `a2` (A,
wait).

1. Attempt 1 throws after take-in. The worker saves `paused: continue`
   with `nextAttemptAtMs`, `errors: 1`, and releases the lock cleanly. `work()` case 4 resumes it
   next. Case 3 does not fire, so the restart is not used and the error
   counts once.
2. Attempts 2–5 fail the same way. On `errors: 5` the worker calls
   `finishTurn(failed: error)`.
3. A's thread gets the error message. `req_a1` becomes `answered`,
   `failed`. The processing reaction completes.
4. The inbox still has `b1` and `a2`. T2 starts for B.

Today: the conversation goes `failed`, waiting messages are dropped, and T1
stays open (bugs 1 and 11).

### E5. Stop after a post

Before: T1 for A (started 12:00) posted response 1 (`sent`).

1. A clicks stop at 12:02. `stop()` sets `stopAtMs` on the conversation
   and notifies a worker. It does not touch T1's row.
2. The running worker sees that T1 is under the stop (its input is older
   than 12:02) at its next safe point and calls `finishTurn(stopped: person)`.
3. Response 1 stays. No more responses (Decided).

### E6. A delivery that keeps failing while finishing

Before: T1 `finishing` with `failed: error`. Slack returns a retryable
error for the error message.

1. Attempt 1 fails. The delivery gets `attempts: 1`,
   `nextAttemptAtMs: +30 s`. The worker sets `wakeAtMs` and releases.
2. Attempts 2–5 fail the same way, with longer waits.
3. The delivery becomes `failed`. `finishTurn` goes on: `req_1` becomes
   `answered`, T1 becomes `failed`, and `turn.terminal` has
   `deliveryFailed: true`.

T1 does not stay `finishing`, and the next turn can start.

### E7. A message that arrives while the lock is held

1. W1 holds the lock and has finished T1. The inbox is empty.
2. B's message `b1` arrives. `send()` locks the conversation row, inserts
   `req_b1`, sets `wakeAtMs = now`, commits and notifies. W2 fails to take
   the lock and exits.
3. W1's release locks the row, reads the inbox and finds `req_b1`.
   `nextRunAtMs` is now, so it keeps `wakeAtMs = now`, sets the expiry to
   null and commits. Then it notifies a worker. W3 runs T2 for B.

Had `send()` come during the release, it would wait for the row lock, set
`wakeAtMs = now` after the release, and its notify would find the lock
free. If W1 died before step 3, the repair job finds `wakeAtMs` in the past
in the wake-time index, sees no live lock after the expiry, and notifies a
worker.
