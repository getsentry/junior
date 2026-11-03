# Interfaces: Worker Lock, Turns And Finishing

Sketches for review, not final code. Labels follow `../design.md`.

## Worker Lock

```ts
/** Redis token plus the SQL lock version it raised (P5). */
type WorkerLock = {
  conversationId: ConversationId;
  token: string;
  lockVersion: number;
  lastCheckInAtMs: number;
  /** lastCheckInAtMs + 90 s. */
  expiresAtMs: number;
};

/**
 * Take the Redis lock, then raise the SQL lock version and keep the new
 * value. Undefined when another worker holds a live lock.
 */
function acquireWorkerLock(
  conversationId: ConversationId,
): Promise<WorkerLock | undefined>;

/** Every 15 s. False: the lock is lost. The worker stops at once. */
function checkIn(lock: WorkerLock): Promise<boolean>;

/** Thrown by any save or post that carries an old lock version. */
type LockLostError = Error & {
  code: "lock_lost";
  conversationId: ConversationId;
  /** The version the worker held. */
  held: number;
  /** The version in SQL. */
  current: number;
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
  status:
    | "running"
    | "paused"
    | "finishing"
    | "completed"
    | "failed"
    | "blocked"
    | "stopped";
  pause?: TurnPause;
  /** Set when status becomes "finishing". finishTurn reads it on resume. */
  outcome?: TurnOutcome;
  stopRequestedAtMs?: number;
  /** Turn errors after its input was taken in. Limit 5 (Decided). */
  errors: number;
  /** Restarts after a lost worker. Limit 1 (Decided; P4). */
  restarts: number;
  totals: {
    slices: number;
    toolCalls: number;
    costUsd: number;
    durationMs: number;
  };
  checkpoint: { historySeq: number; boundaryKey: string };
  deliveries: Delivery[];
  sandboxPassId?: string;
  /** Lock version of the last save. */
  lockVersion: number;
};

type TurnPause =
  | {
      reason: "soft_time_limit" | "hard_time_limit" | "post_retry";
      resumedFrom: string;
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
  | "error" // last of 5 turn errors
  | "lost_worker" // lost again after its one restart
  | "no_progress"
  | "limit" // slices, tool calls or cost; first try
  | "input_dropped"; // its input hit 5 delivery attempts

/** One response to one reply target. The id goes with the post (P5). */
type Delivery = {
  deliveryId: string; // turnId + response index + target
  target: ReplyTarget;
  state: "intended" | "sent";
  providerMessageId?: string;
};
```

## Current Turn

```ts
/**
 * The conversation's open turn, if any. This is #2567's currentTurnId: the
 * one row with an open status, enforced by a partial unique index (P2).
 * Stop, sign-in and the dashboard key by its turnId, not by an attempt id.
 */
function currentTurn(
  conversationId: ConversationId,
): Promise<TurnRecord | undefined>;

/**
 * Create the turn row for the first selected message, under the lock. Fails
 * when an open row exists (the index refuses it). Reads actor, access,
 * source and route from the starting request record, never from text.
 */
function startTurn(
  lock: WorkerLock,
  first: InboundMessage,
  request: RequestView,
): Promise<TurnRecord>;
```

## Saves

A checkpoint save and a history commit are the same write. There is no
history write outside `saveCheckpoint`.

```ts
/**
 * One SQL transaction: check the lock version, append history, update the
 * turn row. Then remove taken-in messages from the inbox (Redis, token
 * check). Throws LockLostError on an old version.
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

`takeIn` adds request ids to `turn.requestIds` in the same transaction. Inbox
removal comes after the commit (rule 6). A crash between them leaves the
message in the inbox. The next worker sees its request id in the open turn
and removes it without adding it again (E1).

## Worker

```ts
/**
 * The only worker. Every kind of conversation uses it. Takes the lock, then
 * does the first that applies:
 * 1. open turn "finishing": run finishTurn again with the saved outcome;
 * 2. open turn "running" (no live worker): restart once, or fail (P8);
 * 3. open turn "paused": resume it; new input from the turn's own person
 *    supersedes a sign-in wait (access.md);
 * 4. no open turn: start one from selectTurnInput.
 * Then notify a worker again if work is left.
 */
function work(conversationId: ConversationId): Promise<void>;
```

## Delivery And Finishing

```ts
/**
 * Send one assistant response to each distinct reply target of the turn's
 * requests, once. Saves the intent (fenced), posts with the delivery id,
 * saves the provider message id. Parent targets get only the turn's result
 * at finishTurn.
 */
function deliver(
  lock: WorkerLock,
  turn: TurnRecord,
  response: Response,
): Promise<void>;

/**
 * The only way a turn ends. Resumable: a worker that finds the turn
 * "finishing" calls it again with the saved outcome. Steps:
 * 1. save status "finishing" and the outcome (fenced);
 * 2. send the error message, ending note, child result or Automation
 *    outcome to each reply target, with fixed delivery ids;
 * 3. mark each request record "answered" with its outcome, or "stopped";
 * 4. revoke the sandbox pass;
 * 5. save the finished status and write one `turn.terminal` event.
 */
function finishTurn(
  lock: WorkerLock,
  turn: TurnRecord,
  outcome: TurnOutcome,
): Promise<void>;
```

## Stop

```ts
/**
 * Save a stop request on the open turn. A worker sees it at the next safe
 * point and before each post. A top-level stop also stops every
 * conversation below it (Decided). Input from a person is kept.
 */
function stop(
  conversationId: ConversationId,
  by: StopBy,
): Promise<{ stopped: boolean }>;

type StopBy =
  | { kind: "person"; actor: PersonActor } // Slack stop, dashboard, ACP
  | { kind: "opt_out"; actor: PersonActor } // Slack thread opt-out
  | { kind: "parent"; parentConversationId: ConversationId } // stopAgent
  | { kind: "tree"; rootConversationId: ConversationId };
```

## Examples

### E1. Redelivered prompt

Before: inbox `[m1 (request r1)]`. No open turn. Lock version 6.

1. W1 takes the lock (v7). `saveCheckpoint` commits the prompt and creates
   T1 with `requestIds: [r1]`.
2. W1 dies before it removes `m1` from the inbox.
3. The lock expires. W2 takes it (v8).
4. `work()` finds T1 `running` and `m1` in the inbox. `r1` is in
   `T1.requestIds`, so W2 removes `m1` and does not add it again.
5. T1 has `restarts: 0`, so W2 restarts it from the checkpoint and sets
   `restarts: 1`.

After: history has one copy of the prompt. The sender check does not run
again on a saved message.

### E2. Dead worker

Before: T1 `running`, lock v7, last checkpoint at 12:00:00.

1. W1 checks in at 12:00:10, then dies at 12:00:20.
2. At 12:01:40 (90 s after the last check-in) the lock expires. The timer
   job clears it and notifies a worker. It does not touch T1.
3. W2 takes the lock (v8). T1 is `running`, `restarts: 0`, slices left. W2
   sets `restarts: 1` and continues from the 12:00:00 checkpoint.
4. Work done between 12:00:00 and 12:00:20 runs again. A post from that time
   has a saved intent; W2 asks the provider for its delivery id before it
   posts again.

If W2 also dies before its first save: the next worker finds `restarts: 1`
and calls `finishTurn` with `failed: lost_worker`.

### E3. Slow worker refused by the lock version

Before: W1 holds v7 and runs T1.

1. W1 stalls. It misses its check-ins for 90 s.
2. W2 takes the lock. SQL lock version becomes 8. W2 restarts T1.
3. W1 wakes and calls `saveCheckpoint` with v7. The transaction reads
   version 8 and throws `LockLostError`. W1 stops. Nothing is saved.
4. Had W1 tried to post first, the delivery intent save would fail the same
   way, so the post never happens.

### E4. Retries running out

Before: T1 for A took in `a1`. The inbox has `b1` (B) and `a2` (A, wait).

1. Five attempts of T1 fail with errors after the input was taken in.
   `errors` goes 1 to 5. Each attempt restarts from the last checkpoint.
2. On the fifth error the worker calls `finishTurn` with
   `failed: error` and an event id.
3. A's Slack thread gets the error message. `r(a1)` becomes `answered` with
   outcome `failed`. The processing reaction completes.
4. The inbox still has `b1` and `a2`. T2 starts for B.

Today: the conversation goes `failed`, all waiting messages are dropped, and
T1 stays open (bugs 1 and 11).

### E5. Stop after a post

Before: T1 for A posted response 1 (delivery `sent`).

1. A clicks stop. `stop()` saves `stopRequestedAtMs` on T1.
2. At the next safe point the worker calls `finishTurn` with
   `stopped: person`.
3. Response 1 stays visible. No more responses are sent (Decided).
