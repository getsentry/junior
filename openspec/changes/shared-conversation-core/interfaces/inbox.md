# Interfaces: Conversations, Inbox And Request Records

Sketches for review, not final code. Plain types and functions. Labels follow
`../design.md`: every item is **Decided** (P-numbers).

## Conversation And Policy

```ts
/** SQL. One agent: top-level, child or plugin-started. Set once at create. */
type Conversation = {
  conversationId: ConversationId;
  /** Child agents only. Stop and result checks walk this. Never changes. */
  parentConversationId?: ConversationId;
  rootConversationId: ConversationId;
  /** Slack thread, if any. Never changes. */
  location?: Location;
  visibility: "public" | "private";
  policy: ConversationPolicy;
  /** Worker lock (P5). Only the compare-and-set writes these two. Release
   * sets lockExpiresAtMs to null. */
  lockExpiresAtMs?: number;
  lockVersion: number;
  /** clock_timestamp() of the stop() transaction, read after it holds its
   * row locks (P34, P44). A turn that took in input received before it is
   * stopped. */
  stopAtMs?: number;
  /** Who stopped it. finishTurn reads it to choose the child result. */
  stopBy?: StopBy["kind"];
  /**
   * Next wake. send() and stop() set it to now; the release sets it to
   * nextRunAtMs. Each locks this row (P32, P34). A SQL index on it is the
   * wake-time index that the repair job reads (P7).
   */
  wakeAtMs?: number;
};

/**
 * What differs by kind. Plain data that the core reads. There is no kind
 * field: the values carry the difference (design.md, What Differs By Kind).
 */
type ConversationPolicy = {
  /** False: a sign-in need ends the turn `blocked`. Person actors only. */
  canAskUser: boolean;
  /** Child agents also take `wait` input into a running turn. */
  joinRule: "now" | "now_or_wait";
  /** Child agents only. Set at spawn (spawn-agent.ts:140 on main). */
  agentType?: string;
  /** Child agents only. Model profile and reasoning chosen at spawn. */
  route?: TurnRoute;
};

/** The one result vocabulary for turns, request records and results. */
type Outcome = "completed" | "failed" | "blocked" | "stopped";
```

## Request Record And Inbox

One kind of record for every input (P23). The record is the inbox entry:
the inbox is the `open` records with no `turnId`. There is no other inbox
store.

```ts
/**
 * SQL. Who asked, with whose access, where results go, and the input
 * itself. No run status. Unique on (conversationId, inboundMessageId): the
 * one duplicate check (P23).
 */
type RequestRecord = {
  /** `req_…`, minted by core. Callers never choose it (P26). */
  requestId: RequestId;
  /** The conversation that does the work. */
  conversationId: ConversationId;
  /** From the source's own id, so a provider retry gets the same id. For
   * input that core makes, a fixed key: the asking turnId + toolCallId,
   * or the child's turnId + parent for a result (P26). */
  inboundMessageId: string;
  /** A person actor needs a VerifiedPersonActor, which only core person
   * ingress makes (rule 12, P39). The record write asserts it. */
  actor: Actor;
  /** Only with a system actor. Bound and signed by core (P17). */
  credentialSubject?: SignedCredentialSubject;
  /** Where results go. Empty: stored, history only (P18). */
  replyTo: ReplyTarget[];
  /** The record whose turn created this one. Result turns reply there (P6). */
  onBehalfOf?: RequestId;
  /** Result and parent-message records only (P26). The asked records. */
  answers?: RequestId[];
  /** Result and parent-message records only. Core reads it from the
   * child's own save, never from input. The parent checks this turn row. */
  sentBy?: { conversationId: ConversationId; turnId: TurnId };
  /** Child agents: what the parent asked for. The agent type and route are
   * set once at spawn, so they live on the child's ConversationPolicy. */
  task?: { title: string; text: string };
  source: "slack" | "web" | "acp" | "cli" | "event" | "agent" | "plugin";
  join: "now" | "wait";
  /** When it was sent. Orders input. */
  createdAtMs: number;
  /** clock_timestamp() of the insert, read after the transaction holds its
   * row locks, so its order with a stop is commit order (P44). Drives the
   * event window, judges stops and orders results against a stop (P34,
   * P35). */
  receivedAtMs: number;
  /** Attempts to start a turn with it. work() raises it in a commit before
   * the attempt does any work, so a crash still counts. Limit 5 (P22). */
  attemptCount: number;
  input: { text: string; attachments?: Attachment[]; eventKind?: string };
  traceContext?: TraceContext;
  /** The turn that took it in, set in that turn's save (rule 6). None: it
   * is in the inbox. finishTurn(stopped) clears it for input that goes
   * back (P34). */
  turnId?: TurnId;
  /** Only finishTurn changes it, with `WHERE status = 'open'` (rule 7). */
  status: "open" | "answered" | "stopped";
  outcome?: Outcome;
};

/** Where a turn's responses go. Never inferred. The kind fixes what it
 * gets (edges.md, P18). */
type ReplyTarget =
  | { kind: "location" } // the conversation's Slack thread: each response
  | {
      kind: "parent"; // the one result
      parentConversationId: ConversationId;
      toolCallId: string;
    }
  | { kind: "destination"; destination: Destination }; // the one result; only Automation creation sets it
```

## Functions

```ts
/**
 * Core only; plugins cannot import it (P39). One transaction: lock the
 * conversation row FOR UPDATE, insert the record with receivedAtMs =
 * clock_timestamp(), set wakeAtMs to now.
 * Then notify a worker. Never runs work. The unique key makes a repeat a
 * duplicate (P23, P32).
 */
function send(record: RequestRecord): Promise<SendResult>;

/** send() never refuses. Busy (ACP) and the automated-turn limit are
 * checked before createRequest saves anything. */
type SendResult = { status: "accepted" } | { status: "duplicate" }; // a waiting copy may be upgraded (files, join now)

/**
 * Core only; plugins cannot import it (P39). Mint the request id, bind the
 * unbound subject to it (bindSubject, P17), then send() the record. Safe to
 * retry: the same inboundMessageId is a duplicate. Throws, and saves
 * nothing, for an event or a top-level agent message when the conversation
 * is at the automated-turn limit, so messageAgent gets a sync error.
 */
function createRequest(
  record: Omit<
    RequestRecord,
    "requestId" | "status" | "turnId" | "receivedAtMs" | "credentialSubject"
  > & {
    subject?: {
      unbound: UnboundCredentialSubject;
      scope: SignedCredentialSubject["scope"];
    };
  },
): Promise<{ record: RequestRecord; send: SendResult }>;

/**
 * Pure. Pick the next turn's input from the inbox: one contiguous run with
 * one actor, one exact signed subject and one source. Join now before
 * wait, people before events, then createdAtMs, receivedAtMs, id. Events
 * wait for their window. Returns the records to drop: a result whose
 * sentBy turn row is not in a child of this conversation or whose answers
 * do not name this parent (`sender_mismatch`) (P26).
 */
function selectTurnInput(
  inbox: RequestRecord[],
  senders: ReadonlyMap<TurnId, TurnRecord>,
  nowMs: number,
): {
  take: RequestRecord[];
  drop: { record: RequestRecord; reason: string }[];
};

/**
 * Pure. True when a waiting message may join the running turn at its next
 * safe point. Same actor, exact same signed subject, same source; never an
 * event, a plugin message, a result or another person (Decided).
 */
function canJoin(
  turn: TurnRecord,
  record: RequestRecord,
  policy: ConversationPolicy,
): boolean;
```

`canJoin` sketch:

```ts
function canJoin(turn, record, policy) {
  if (record.source === "event" || record.source === "plugin") return false;
  if (isChildResult(record)) return false; // results never join (today's rule)
  if (!sameActor(record.actor, turn.actor)) return false;
  // Exact signed-subject equality, scope included (P20).
  if (!sameSignedSubject(record.credentialSubject, turn.credentialSubject))
    return false;
  if (record.source !== turn.source) return false;
  return record.join === "now" || policy.joinRule === "now_or_wait";
}
```

## Examples

### E1. Duplicate Slack delivery

Before: inbox `[]`.

1. Slack ingress calls `createRequest` with id `slack:T:C:111` (A,
   `[location]`). `send()` inserts `req_1`. Result `accepted`. Inbox
   `[req_1]`.
2. Slack retries with the same id and a file. The insert hits the unique
   key, so `send()` returns `duplicate`. The waiting record gets the file
   and keeps its timestamps.

After: inbox `[req_1 + file]`. One record. One worker notification.

### E2. Batch split by actor

Before: inbox `[A1 (wait), B1 (wait), A2 (wait)]`, no open turn.

1. `selectTurnInput` takes `[A1]`. Turn T1 for A.
2. After T1: `[B1]`. Turn T2 for B.
3. After T2: `[A2]`. Turn T3 for A.

A2 never joins T1: B1 is between them, and the run is contiguous.

### E3. Events with different access (P20, Decided)

Before: three events arrive inside one window. `e1` from A's timer Watch
(subject `sA`, scope Watch W1), `e2` from a second timer of A's (subject
`sA'`, scope Watch W2), `e3` a CI event with no grant.

1. The window ends 30 s after `e1`, plus 5 s per extra event: 40 s.
2. `selectTurnInput` groups by actor and exact signed subject before any
   turn starts: `[e1]`, `[e2]`, `[e3]`. `sA` and `sA'` have the same user but a different scope,
   so they do not share a turn.
3. Three turns run, all as the system actor.

Today (bug): one turn with no delegated access, because `e3` has no grant
(`timerWatchCredentialSubject`, P20). A batch never mixes access.

### E4. Plain reply from the turn's own author

Before: T1 running for A. A posts a plain thread reply (`join: wait`).

1. `canJoin(T1, reply)` is false: Slack's `joinRule` is `now`.
2. The reply waits. When T1 ends, T2 starts with it (Decided).

### E5. A result from a conversation that is not a child (P26, Decided)

Before: conversation X's inbox has `req_9`, a result record whose `sentBy`
names turn T7 of conversation Y. Y is not a child of X.

1. `selectTurnInput` loads T7. Its conversation is not a child of X.
2. `req_9` goes in `drop` with reason `sender_mismatch`. No turn starts.
3. The worker closes it through a closing turn. X never takes in Y's
   result.

A message cannot point at another conversation's record: the record is the
inbox entry (P23).
