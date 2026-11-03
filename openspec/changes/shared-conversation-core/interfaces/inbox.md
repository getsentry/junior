# Interfaces: Conversations, Inbox And Request Records

Sketches for review, not final code. Plain types and functions. Labels follow
`../design.md`: **Decided** or **Proposed, needs sign-off** (P-numbers).

## Conversation And Policy

```ts
/** One agent: top-level, child or plugin-started. Set once at create. */
type Conversation = {
  conversationId: ConversationId;
  /** Child agents only. Stop and result routing walk this. Never changes. */
  parentConversationId?: ConversationId;
  rootConversationId: ConversationId;
  /** Slack thread, if any. Never changes. */
  location?: Location;
  visibility: "public" | "private";
  policy: ConversationPolicy;
  /** SQL lock version counter. Raised each time a worker takes the lock. */
  lockVersion: number;
};

/**
 * What differs by kind of conversation. Plain data that the core reads.
 * The core never calls back into per-kind code (#2499).
 */
type ConversationPolicy = {
  kind: "slack" | "web" | "acp" | "cli" | "child" | "plugin_started";
  /** False: a sign-in need ends the turn `blocked`. */
  canAskUser: boolean;
  /** Child agents also take waiting messages into a running turn. */
  joinRule: "join_now" | "join_now_or_wait";
  /** ACP refuses new input while a turn is open. */
  whenBusy: "wait" | "refuse";
};
```

## Inbox And Inbound Message

```ts
/** Redis. The inbox and the worker lock token. It holds no turn status. */
type ConversationExecution = {
  conversationId: ConversationId;
  inbox: InboundMessage[];
  /** Duplicate check. Kept 7 days. */
  seenInboundMessageIds: string[];
  workerLock?: WorkerLock;
  /** Next wake: event wait window end, or sign-in link expiry. */
  wakeAtMs?: number;
};

/** One normalized input. It grants no access by itself (rule 10). */
type InboundMessage = {
  /** From the source's own id, so a provider retry gets the same id. */
  inboundMessageId: string;
  conversationId: ConversationId;
  /** The request record it belongs to (P23: inline for person input). */
  requestId: RequestId;
  inlineRequest?: InlineRequest;
  source: "slack" | "web" | "acp" | "cli" | "event" | "agent" | "plugin";
  delivery: "join_now" | "wait";
  /** When it was sent. Orders input. */
  createdAtMs: number;
  /** When Junior got it. Drives the event wait window. */
  receivedAtMs: number;
  /** Delivery attempts before a turn takes it in. Limit 5. */
  attemptCount: number;
  input: { text: string; attachments?: Attachment[]; eventKind?: string };
  traceContext?: TraceContext;
};

/**
 * Person input, and events with no grant (P23). Its request id is the
 * inbound message id. It never carries delegated access (rule 10).
 */
type InlineRequest = {
  actor: PersonActor | SystemActor;
  replyTo: { kind: "location" } | { kind: "stored" };
};
```

## Request Record

```ts
/**
 * SQL. Who asked, with whose access, and where results go. No run status.
 * Replaces the Agent invocation row and the dispatch record.
 */
type RequestRecord = {
  requestId: RequestId;
  /** The conversation that does the work. */
  conversationId: ConversationId;
  /** Same key with other input throws. Example: parent turnId + toolCallId. */
  idempotencyKey: string;
  actor: Actor;
  /** Only with a system actor. Signed by the runtime (P17). */
  credentialSubject?: SignedCredentialSubject;
  replyTo: ReplyTarget;
  /** The request whose turn created this one. Follow-ups use it (P6). */
  onBehalfOf?: RequestId;
  /** Child agents: what the parent asked for. */
  task?: { title: string; text: string; agentType: string; route: TurnRoute };
  status: "open" | "answered" | "stopped";
  /** Set with "answered". */
  outcome?: "completed" | "failed" | "blocked" | "no_action";
  /** Repair job reads this (P7). */
  inputAppendedAtMs?: number;
  createdAtMs: number;
};

/** A stored record, or an inline request seen through the same fields. */
type RequestView = Pick<
  RequestRecord,
  "requestId" | "actor" | "credentialSubject" | "replyTo"
>;

/** Where a turn's responses go. Stored, never inferred from Source. */
type ReplyTarget =
  | { kind: "location" } // the conversation's Slack thread
  | { kind: "stored" } // web, ACP, CLI: history is the delivery
  | { kind: "parent"; parentConversationId: ConversationId; toolCallId: string }
  | { kind: "automation_run"; automationRunId: string }
  | { kind: "plugin"; plugin: string };
```

## Functions

```ts
/**
 * Add one message to a conversation's inbox and notify a worker. Never runs
 * work. The same inboundMessageId is accepted once.
 */
function send(message: InboundMessage): Promise<SendResult>;

type SendResult =
  | { status: "accepted" }
  | { status: "duplicate" } // a pending copy may be upgraded (attachments, join now)
  | { status: "refused"; reason: "busy" | "automated_turn_limit" | "stopped" };

/**
 * Save a request record, then send its input. Safe to retry with the same
 * idempotency key. The repair job retries the send when it was lost (P7).
 */
function createRequest(
  record: Omit<RequestRecord, "status" | "createdAtMs">,
  input: Omit<InboundMessage, "requestId">,
): Promise<RequestRecord>;

/**
 * Pure. Pick the input for the next turn: one contiguous run with one actor,
 * one whose-access and one source. Join now before wait, people before
 * events, then by createdAtMs, receivedAtMs, id. Events wait for their window.
 */
function selectTurnInput(
  execution: ConversationExecution,
  requests: ReadonlyMap<RequestId, RequestRecord>,
  nowMs: number,
): InboundMessage[];

/**
 * Pure. True when a waiting message may join the running turn at its next
 * safe point. Same actor and whose-access, and never an event, a plugin
 * message or another person (Decided).
 */
function canJoin(
  turn: TurnRecord,
  message: InboundMessage,
  request: RequestView,
  policy: ConversationPolicy,
): boolean;
```

`canJoin` sketch:

```ts
function canJoin(turn, message, request, policy) {
  if (message.source === "event" || message.source === "plugin") return false;
  if (isChildResult(message)) return false; // results never join (today's rule)
  if (!sameActor(request.actor, turn.actor)) return false;
  if (!sameAccess(request.credentialSubject, turn.credentialSubject))
    return false;
  if (message.source !== turn.source) return false;
  return (
    message.delivery === "join_now" || policy.joinRule === "join_now_or_wait"
  );
}
```

## Examples

### E1. Duplicate Slack delivery

Before: inbox `[]`, seen `[]`.

1. `send(m1)` with id `slack:T:C:111`. Result `accepted`. Inbox `[m1]`.
2. Slack retries with the same id and a file. `send(m1')` returns
   `duplicate`. The pending entry gets the file and keeps its timestamps.

After: inbox `[m1 + file]`. One worker notification.

### E2. Batch split by actor

Before: inbox `[A1 (wait), B1 (wait), A2 (wait)]`, no open turn.

1. `selectTurnInput` returns `[A1]`. Turn T1 for A.
2. After T1: `[B1]`. Turn T2 for B.
3. After T2: `[A2]`. Turn T3 for A.

A2 never joins T1, because B1 is between them and the run is contiguous.

### E3. Mixed-access event batch (P20, Proposed)

Before: three events arrive inside one wait window. `e1` from A's timer Watch
(A's delegated access), `e2` from B's timer Watch (B's), `e3` a CI event with
no grant.

1. The window ends 30 s after `e1` plus 5 s per extra event: 40 s.
2. `selectTurnInput` groups by actor and whose-access, in first-arrival
   order: `[e1]`, `[e2]`, `[e3]`.
3. Three turns run, all as the system actor: T1 with A's grant, T2 with B's,
   T3 with none.

Today: one turn with no delegated access.

### E4. Plain reply from the turn's own author

Before: T1 running for A. A posts a plain thread reply (`wait`).

1. `canJoin(T1, reply)` is false: Slack policy is `join_now`.
2. The reply waits. When T1 ends, T2 starts with it (Decided).
