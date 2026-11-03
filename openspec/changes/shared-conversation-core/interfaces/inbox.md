# Interfaces: Conversations, Inbox And Request Records

Sketches for review, not final code. Plain types and functions. Labels follow
`../design.md`: **Decided** or **Proposed, needs sign-off** (P-numbers).

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
  /** Worker lock (P5). Only the compare-and-set writes these three. */
  lockToken?: string;
  lockExpiresAtMs?: number;
  lockVersion: number;
  /** Set by stop() (P34). A turn that took in input older than it is
   * stopped. Which clock stamps it is P44. */
  stopAtMs?: number;
  /** Who stopped it. finishTurn reads it to choose the child result. */
  stopBy?: StopBy["kind"];
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
  /** ACP refuses new input while a turn is open. */
  whenBusy: "wait" | "refuse";
};

/** The one result vocabulary for turns, request records and results. */
type Outcome = "completed" | "failed" | "blocked" | "stopped";
```

## Inbox And Inbound Message

```ts
/** Redis. The inbox and wake time. No lock, no turn status. */
type ConversationInbox = {
  conversationId: ConversationId;
  inbox: InboundMessage[];
  /** Duplicate check. Kept 7 days. */
  seenInboundMessageIds: string[];
  /** Raised by every send(). The pre-release wake set compares it (P32). */
  inboxSeq: number;
  /**
   * Next wake. send() sets it to now; before release, a worker sets it to
   * nextRunAtMs with a compare-and-set on inboxSeq. Mirrored in the
   * wake-time index, a Redis sorted set the repair job reads (P7, P32).
   */
  wakeAtMs?: number;
};

/** One normalized input. It grants no access by itself (rule 10). */
type InboundMessage = {
  /** From the source's own id, so a provider retry gets the same id. */
  inboundMessageId: string;
  conversationId: ConversationId;
  /** Minted by core (P26). Its record must match this message. */
  requestId: RequestId;
  source: "slack" | "web" | "acp" | "cli" | "event" | "agent" | "plugin";
  join: "now" | "wait";
  /** When it was sent. Orders input. */
  createdAtMs: number;
  /** When Junior got it. Drives the event window. */
  receivedAtMs: number;
  /** Delivery attempts before a turn takes it in. Limit 5. */
  attemptCount: number;
  input: { text: string; attachments?: Attachment[]; eventKind?: string };
  traceContext?: TraceContext;
};
```

## Request Record

One kind of record for every input (P23).

```ts
/** SQL. Who asked, with whose access, and where results go. No run status. */
type RequestRecord = {
  /** `req_…`, minted by core. Callers never choose it (P26). */
  requestId: RequestId;
  /** The conversation that does the work. */
  conversationId: ConversationId;
  /** The one inbox message for this record. */
  inboundMessageId: string;
  /** Same key with other input throws. Example: parent turnId + toolCallId. */
  idempotencyKey: string;
  /** A person actor needs a VerifiedPersonActor, which only core person
   * ingress makes (rule 12, P39). The record write asserts it. */
  actor: Actor;
  /** Only with a system actor. Bound and signed by core (P17). */
  credentialSubject?: SignedCredentialSubject;
  replyTo: ReplyTarget;
  /** The record whose turn created this one. Result turns reply there (P6). */
  onBehalfOf?: RequestId;
  /** Result and parent-message records only (P26). The asked records. */
  answers?: RequestId[];
  /** Result and parent-message records only. Read from the child's own
   * save, never from a message. The parent checks this turn row. */
  sentBy?: { conversationId: ConversationId; turnId: TurnId };
  /** Child agents: what the parent asked for. */
  task?: { title: string; text: string; agentType: string; route: TurnRoute };
  /** Only finishTurn changes it, with `WHERE status = 'open'` (rule 7). */
  status: "open" | "answered" | "stopped";
  outcome?: Outcome;
  /** The repair job writes only these stamps (P7). */
  repair: {
    inputAppendedAtMs?: number;
    attempts: number;
    refusedAtMs?: number;
    gaveUpAtMs?: number;
  };
  createdAtMs: number;
};

/** Where a turn's responses go, and which ones (P18). Never inferred. */
type ReplyTarget =
  | { kind: "location"; responses: "each" } // the conversation's Slack thread
  | { kind: "stored"; responses: "each" } // web, ACP, CLI: history only
  | {
      kind: "parent";
      responses: "result";
      parentConversationId: ConversationId;
      toolCallId: string;
    }
  | { kind: "automation_run"; responses: "declared"; automationRunId: string };
```

## Functions

```ts
/**
 * Core only; plugins cannot import it (P39). Add one message to a
 * conversation's inbox, raise inboxSeq, set wakeAtMs to now, and notify a
 * worker. Never runs work. The same inboundMessageId is accepted once.
 */
function send(message: InboundMessage): Promise<SendResult>;

type SendResult =
  | { status: "accepted" }
  | { status: "duplicate" } // a waiting copy may be upgraded (files, join now)
  | { status: "refused"; reason: "busy" | "automated_turn_limit" | "stopped" };

/**
 * Core only; plugins cannot import it (P39). Mint the request id, bind the
 * unbound subject to it (bindSubject, P17), save the record, then send its
 * message. Safe to retry with the same idempotency key. Stamps
 * inputAppendedAtMs on accepted or duplicate. On refused, stamps
 * refusedAtMs; the worker closes the record (P30).
 */
function createRequest(
  record: Omit<
    RequestRecord,
    "requestId" | "status" | "repair" | "createdAtMs" | "credentialSubject"
  > & {
    subject?: {
      unbound: UnboundCredentialSubject;
      scope: SignedCredentialSubject["scope"];
    };
  },
  input: Omit<InboundMessage, "requestId">,
): Promise<{ record: RequestRecord; send: SendResult }>;

/**
 * Pure. Pick the next turn's input: one contiguous run with one actor, one
 * exact signed subject and one source. Join now before wait, people before
 * events, then createdAtMs, receivedAtMs, id. Events wait for their window.
 * Returns the messages to drop: no record, a record whose conversationId or
 * inboundMessageId does not match (`record_mismatch`), or a result whose
 * sentBy turn row is not in a child of this conversation or whose answers
 * do not name this parent (`sender_mismatch`) (P26).
 */
function selectTurnInput(
  inbox: ConversationInbox,
  records: ReadonlyMap<RequestId, RequestRecord>,
  senders: ReadonlyMap<TurnId, TurnRecord>,
  nowMs: number,
): {
  take: InboundMessage[];
  drop: { message: InboundMessage; reason: string }[];
};

/**
 * Pure. True when a waiting message may join the running turn at its next
 * safe point. Same actor, exact same signed subject, same source; never an
 * event, a plugin message, a result or another person (Decided).
 */
function canJoin(
  turn: TurnRecord,
  message: InboundMessage,
  record: RequestRecord,
  policy: ConversationPolicy,
): boolean;
```

`canJoin` sketch:

```ts
function canJoin(turn, message, record, policy) {
  if (message.source === "event" || message.source === "plugin") return false;
  if (isChildResult(message)) return false; // results never join (today's rule)
  if (!sameActor(record.actor, turn.actor)) return false;
  // Exact signed-subject equality, scope included (P20).
  if (!sameSignedSubject(record.credentialSubject, turn.credentialSubject))
    return false;
  if (message.source !== turn.source) return false;
  return message.join === "now" || policy.joinRule === "now_or_wait";
}
```

## Examples

### E1. Duplicate Slack delivery

Before: inbox `[]`, seen `[]`.

1. Slack ingress mints `req_1` (A, `location`), then `send(m1)` with id
   `slack:T:C:111`. Result `accepted`. Inbox `[m1]`.
2. Slack retries with the same id and a file. Ingress finds `req_1` by its
   idempotency key (the message id) and does not mint again. `send(m1')`
   returns `duplicate`. The waiting entry gets the file and keeps its
   timestamps.

After: inbox `[m1 + file]`. One record. One worker notification.

### E2. Batch split by actor

Before: inbox `[A1 (wait), B1 (wait), A2 (wait)]`, no open turn.

1. `selectTurnInput` takes `[A1]`. Turn T1 for A.
2. After T1: `[B1]`. Turn T2 for B.
3. After T2: `[A2]`. Turn T3 for A.

A2 never joins T1: B1 is between them, and the run is contiguous.

### E3. Mixed-access event batch (P20, Proposed)

Before: three events arrive inside one window. `e1` from A's timer Watch
(subject `sA`, scope Watch W1), `e2` from a second timer of A's (subject
`sA'`, scope Watch W2), `e3` a CI event with no grant.

1. The window ends 30 s after `e1`, plus 5 s per extra event: 40 s.
2. `selectTurnInput` groups by actor and exact signed subject: `[e1]`,
   `[e2]`, `[e3]`. `sA` and `sA'` have the same user but a different scope,
   so they do not share a turn.
3. Three turns run, all as the system actor.

Today: one turn with no delegated access.

### E4. Plain reply from the turn's own author

Before: T1 running for A. A posts a plain thread reply (`join: wait`).

1. `canJoin(T1, reply)` is false: Slack's `joinRule` is `now`.
2. The reply waits. When T1 ends, T2 starts with it (Decided).

### E5. A message that points at another record (P26, Proposed)

Before: conversation X's inbox gets `m9` with `requestId: req_7`. `req_7`
belongs to conversation Y and has A's delegated subject.

1. `selectTurnInput` loads `req_7`. Its `conversationId` is Y, not X.
2. `m9` goes in `drop` with reason `record_mismatch`. No turn starts.
3. The worker records the drop. X never runs with A's access.
