# Interfaces: Worker Lock, Turns And Finishing

Sketches for review, not final code. Labels follow `../design.md`.

## Worker Lock

```ts
/** What a worker holds. The SQL conversation row is the source (P5). */
type WorkerLock = {
  conversationId: ConversationId;
  token: string;
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

/** Every 15 s. Matches token, version and a live expiry. False: lost. */
function checkIn(lock: WorkerLock): Promise<boolean>;

/**
 * Never called while the turn is running: the pause or finish is saved
 * first, and if that save fails the lock is left to expire (P8). Set
 * wakeAtMs to nextRunAtMs with a compare-and-set on inboxSeq (read the
 * inbox record again if it changed), and queue a delayed notify for
 * wakeAtMs. Clear the token (same match as checkIn). Then read the inbox
 * record again; if wakeAtMs <= now, notify a worker (P32).
 */
function releaseWorkerLock(lock: WorkerLock): Promise<void>;

/**
 * Pure. The one runnable test: the earliest time this conversation has
 * work (now, a link expiry, a delivery's nextAttemptAtMs, an event window
 * end), or undefined. work() and releaseWorkerLock both use it.
 */
function nextRunAtMs(
  state: { turn?: TurnRecord; inbox: ConversationInbox },
  nowMs: number,
): number | undefined;

/** Thrown by any save that does not match the held token and version. */
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
  /** Request records this turn took in. The first one started it. */
  requestIds: RequestId[];
  /** From the starting request record. Never changes. */
  actor: Actor;
  credentialSubject?: SignedCredentialSubject;
  source: InboundMessage["source"];
  /** Model profile and reasoning, chosen at start, kept on resume. */
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
   * Errors after take-in plus lost-worker restarts. Limit 5 (Decided, P4).
   * One failure counts once.
   */
  errors: number;
  /** Lost-worker restarts. Limit 1. Only enforces the one restart (P4). */
  restarts: number;
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
      reason: "soft_time_limit" | "hard_time_limit" | "error_retry";
      resumedFrom: string;
    }
  | { reason: "post_retry"; deliveryId: string }
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
  | "error" // the fifth error, restarts included
  | "lost_worker" // lost after its one restart, or as the fifth error
  | "no_progress"
  | "limit" // attempts, tool calls or cost; first try
  | "post_failed" // a post_retry delivery hit its own limit
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
 * with its requestIds, and commit the prompt to history. Refuses input
 * older than the stop time. Reads actor, access, source and route from the
 * starting record, never from text. Inbox removal comes after the commit.
 */
function startTurn(
  lock: WorkerLock,
  batch: InboundMessage[],
  first: RequestRecord,
): Promise<TurnRecord>;

/**
 * One transaction: check the lock and the stop time, append history,
 * update the turn row, add takeIn request ids. Then remove taken-in
 * messages from the inbox. The only history write. Throws LockLostError,
 * or StoppedError when the turn is under the stop. A takeIn refuses input
 * older than stopAtMs, like startTurn (P34).
 */
function saveCheckpoint(
  lock: WorkerLock,
  turn: TurnRecord,
  change: {
    history: HistoryItem[];
    takeIn?: InboundMessage[];
    turn: Partial<TurnRecord>;
  },
): Promise<TurnRecord>;
```

A crash after the commit and before inbox removal leaves the message in the
inbox. The next worker sees its request id in the open turn and removes it
without adding it again (E1).

## Worker

```ts
/**
 * The only worker. Every kind uses it. Takes the lock, then does the first
 * that applies:
 * 1. open turn "finishing": run finishTurn again with the saved outcome;
 * 2. the open turn is under the stop (oldestInputReceivedAtMs older than
 *    stopAtMs): finishTurn(stopped);
 * 3. open turn "running": the last worker was lost (P8). Restart once,
 *    counting one error (P4), or finishTurn(failed: lost_worker);
 * 4. open turn "paused": resume it, or handle sign-in (access.md);
 * 5. no open turn: run selectTurnInput. Close dropped or stop-cut input
 *    with closeInput, and records the repair job flagged. Then startTurn.
 * Then releaseWorkerLock, which re-checks for work.
 */
function work(conversationId: ConversationId): Promise<void>;
```

## Delivery, Finishing And Closing

```ts
/**
 * Send one response to each distinct reply target of the turn's records,
 * as its kind allows (edges.md). Checks in, then saves a checkpoint
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
 * 2. send the error message, ending note, child result or the
 *    Automation result to each outcome (P18), with fixed delivery ids;
 *    retry with backoff up to 5 attempts, or fail at once on a permanent
 *    provider error (P33). A child result
 *    first mints its record in the parent, in this transaction (P26);
 * 3. move each taken-in record from open to answered or stopped
 *    (WHERE status = 'open'). For finishTurn(stopped), input not older
 *    than stopAtMs goes back in the inbox and its record stays open (P34);
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
  batch: InboundMessage[],
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
parent's own stop time is after the record's `createdAtMs` (a tree stop).
Then the outcome is recorded on the asked record and no turn starts (P35,
Decided). Both stamps are database `now()` (P44).

## Examples

### E1. Redelivered prompt

Before: inbox `[m1 (req_1)]`. No open turn. Lock version 6.

1. W1 takes the lock (v7). `startTurn` creates T1 with `requestIds:
[req_1]` and commits the prompt, in one transaction.
2. W1 dies before it removes `m1` from the inbox.
3. The lock expires. The queue redelivers. W2 takes the lock (v8).
4. `work()` finds T1 `running` (case 3) and `m1` in the inbox. `req_1` is in
   `T1.requestIds`, so W2 removes `m1` and does not add it again.
5. `restarts: 0`, so W2 restarts T1 from its checkpoint: `restarts: 1`,
   `errors: 1` (P4).

After: one copy of the prompt in history. The sender check does not run
again on a saved message.

### E2. Dead worker

Before: T1 `running`, lock v7, last checkpoint at 12:00:00.

1. W1 checks in at 12:00:10 and dies at 12:00:20.
2. At 12:01:40 the lock is expired. On its next pass, the repair job sees a
   `running` turn with an expired lock and notifies a worker. It writes
   nothing.
3. W2's compare-and-set takes the lock (v8). T1 is `running`: lost.
   `restarts: 1`, `errors: 1`. W2 continues from the 12:00:00 checkpoint.
4. A delivery saved as `intended` between 12:00:00 and 12:00:20 is sent
   again from its saved text, after `find` shows it did not land.

If W2 also dies: the next worker finds `restarts: 1` and calls
`finishTurn(failed: lost_worker)`.

### E3. Slow worker refused by the lock version

Before: W1 holds token `t1`, v7, and runs T1.

1. W1 stalls and misses its check-ins for 90 s.
2. W2's compare-and-set matches (expired): token `t2`, v8.
3. W1 wakes and calls `saveCheckpoint`. The transaction's row check needs
   `t1` and v7; the row has `t2` and v8. `LockLostError`. Nothing is saved.
4. Had W1 tried to post, its check-in and its intent save fail the same way.

A Redis expiry cannot reset v8: the counter lives on the SQL row.

### E4. Error retries, then retries running out

Before: T1 for A took in `req_a1`. The inbox has `b1` (B) and `a2` (A,
wait).

1. Attempt 1 throws after take-in. The worker saves `paused: error_retry`,
   `errors: 1`, and releases the lock cleanly. `work()` case 4 resumes it
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

1. W1 holds the lock, has finished T1, and reads the inbox: empty,
   `inboxSeq: 4`. `nextRunAtMs` is undefined.
2. B's message `b1` arrives. `send()` appends it, sets `inboxSeq: 5` and
   `wakeAtMs = now`, and notifies. W2 fails to take the lock and exits.
3. W1's compare-and-set of `wakeAtMs` expects `inboxSeq: 4` and fails. W1
   reads the inbox record again: `b1` is runnable, so `wakeAtMs` stays
   now, and W1 queues a delayed notify for it.
4. W1 releases the lock, then reads the inbox record again. `wakeAtMs` is
   not after now, so it notifies a worker. W3 runs T2 for B.

If W1 died before step 4, the delayed notify fires. If W1 died before
step 3 saved, the repair job finds `wakeAtMs` in the past in
the wake-time index, sees no live lock, and notifies a worker.
