# Interfaces: Child Agents And Plugin-Started Agents

Sketches for review, not final code. Labels follow `../design.md`.

## Asking A Child

```ts
/**
 * spawnAgent and messageAgent both call this. One SQL transaction under the
 * parent conversation row (FOR UPDATE): refuse if the parent turn is
 * under the parent's stop (P34); check the caps (8 children with open work,
 * 4 open records per child); create the child conversation and binding if
 * new; for a new child, insert the request record in this transaction.
 * Commit. An existing child gets its record through send() after the
 * commit, so a transaction holds one existing conversation row. The
 * record's inboundMessageId is parent turnId + toolCallId, so a retried
 * tool call is a duplicate and returns the first result. Never starts a
 * runner.
 */
function askChild(
  parentTurn: TurnRecord,
  args: {
    toolCallId: string;
    child:
      | { conversationId: ConversationId }
      | { spawn: ChildTask; name?: string };
    text: string;
  },
): Promise<{
  conversationId: ConversationId;
  requestId: RequestId;
  send: SendResult;
}>;
```

The record it saves:

- `actor` from `parentTurn` (P15); the parent turn's delegated subject,
  bound again for this record's id, as today until P28 is decided;
- `onBehalfOf`: the parent turn's starting request id;
- `replyTo: [{ kind: "parent", parentConversationId, toolCallId }]`.

`maxAgentDepth` defaults to 1 (Decided): a child can start children, one
level down.

```ts
/**
 * A child's message to its parent, without ending its turn. Needs an open
 * record on the child's current turn. One fenced save in the child records
 * a delivery intent; send() then inserts the record in the parent
 * (`answers`: the turn's open records for this parent; `sentBy`: this
 * turn), keyed by the delivery id (P26). Acts for that turn's actor.
 * Marked as not from a person.
 */
function messageParent(
  childTurn: TurnRecord,
  text: string,
): Promise<SendResult>;
```

## Child Results

```ts
/**
 * The one result record a child turn sends per `parent` reply target, at
 * finishTurn. finishTurn records it as a delivery intent; send() inserts it
 * in the parent with the delivery id as its inboundMessageId, so a resumed
 * finishTurn sends it once (P26). Its `answers` and `sentBy` decide
 * acceptance. The parent reads the task title from the answered records.
 * A result is a follow-up when an `answers` record was already `answered`
 * (P6). The parent turn acts for the answered record's actor (P15) and
 * replies to its onBehalfOf's reply targets (P6).
 */
type ChildResult = RequestRecord & {
  source: "agent";
  join: "wait";
  result: {
    childConversationId: ConversationId;
    outcome: Outcome;
    /** The child's last assistant response, up to 12,000 characters.
     * Missing on "completed" means the child had nothing to say. */
    text?: string;
    /** Siblings whose results have not arrived, so the parent waits. */
    pendingSiblings: ConversationId[];
  };
};
```

The result record that send() inserts in the parent:

- `conversationId`: the parent; `inboundMessageId`: the delivery id;
- `answers`: every record the child turn answered for this parent;
- `sentBy: { conversationId: child, turnId }`;
- `actor` and subject: those of the answered record (P15);
- `replyTo`: the reply targets of the answered record's `onBehalfOf` (P6).

The parent's `selectTurnInput` accepts it only when the `sentBy` turn row
is in a child of the parent, and every `answers` record has that child as
`conversationId` and a `parent` reply target that names the parent (P26).

A result is ordinary inbox input to the parent and wakes it like any other
event (P35, Decided). Like an event, it never joins a running parent turn
and waits for the event window, so sibling results share a turn. It skips
the automated-turn check but counts toward it (Decided). After an explicit
stop, a late result is recorded and never starts a turn.

## Plugin-Started Agents

```ts
/**
 * Create one run. The actor is always { platform: "system", name: plugin };
 * a plugin cannot pass an actor. The plugin passes an unbound subject; core
 * binds and signs it (P17). The record's inboundMessageId is plugin +
 * idempotency key. A plugin can pass only a `location` reply target or
 * none (stored). Only core's Automation runner adds `destination` targets:
 * it copies the Destinations that Automation creation saved, keyed by
 * taskId + scheduledForMs (P18).
 */
function startPluginAgent(args: {
  plugin: string;
  idempotencyKey: string;
  location: Location;
  instruction: string;
  subject?: UnboundCredentialSubject;
  replyTo: [] | [{ kind: "location" }];
}): Promise<{ id: RequestId; created: boolean }>;

/** What a plugin sees (P21). Computed from the record and its turn. */
type PluginAgentView = {
  id: RequestId;
  status: "running" | Outcome;
  resultMessageTs?: string;
  errorMessage?: string;
};
```

## Examples

### E1. Busy child: a message joins, one result covers both

Before: child C runs T1 for `req_1` (actor A, no subject). Parent P calls
`askChild` for C again (`req_2`, actor A).

1. `send(req_2)` inserts `req_2` in C with no `turnId`: it is in C's
   inbox. C's `joinRule` is `now_or_wait`.
2. At T1's next safe point, `canJoin(T1, req_2)` is true. `saveCheckpoint`
   adds `req_2` to `T1.requestIds` and sets `req_2.turnId` to T1 in the
   same write.
3. T1 ends. `finishTurn` records one result delivery for P with `answers:
[req_1, req_2]`, and send() inserts it in P. Both records become
   `answered`.

If `req_2` had actor B: `canJoin` is false, `req_2` waits, and T2 runs for
B with its own result (Decided).

### E2. Grandchild result after the child's turn ended

Before: P's turn (for A, started by Slack record `req_s`) asked C (`req_1`,
`onBehalfOf: req_s`). C's turn T1 asked grandchild G (`req_2`: actor A,
`onBehalfOf: req_1`, `replyTo` parent C).

1. T1 ends before G. P gets a result for `req_1`. `req_1` is `answered`.
2. B messages C at 12:05 (`req_3`, actor B). T2 runs for B and ends.
3. G finishes. Its `finishTurn` records the result, and send() inserts
   `req_r` in C (`answers: [req_2]`, `sentBy`: G's turn). C checks: the
   `sentBy` turn row is in G, a child of C; `req_2` has `conversationId` G
   and a `parent` reply target that names C. Accepted.
4. C starts T3 for `req_2.actor`, A (P15). B's 12:05 message is from
   another actor, so T3's model sees it marked as outside text, and it is
   not approval.
5. T3 replies to `req_1.replyTo`, which names P. `req_1` is already
   `answered`, so P reads the result as a follow-up (P6).
6. P starts a turn for A. It replies to `req_s.replyTo`: the Slack thread.

### E3. Top-level stop of a tree

Before: P (top-level) runs T for A. C1 runs T1; C2 is idle with `m` waiting
(record `req_c2`). C1 has grandchild G running TG.

1. A clicks stop at 12:10. `stop(P)` sets `stopAtMs = 12:10` on P, C1, C2
   and G, and notifies each worker. It writes no turn row and no record.
2. Each worker sees a turn under the stop (its input is older than 12:10)
   and calls `finishTurn(stopped: tree)`. T, T1 and TG mark their records
   `stopped`.
3. C2's worker finds `m` older than 12:10. It is agent input, so
   `closeInput` ends it with no history. `req_c2` becomes `stopped`.
4. C1's and G's asked records are `stopped`. Their parents' stop times are
   after those records were made: an explicit stop, so they send no
   result records and no turn starts (P35, Decided).
5. P's Slack thread gets the "Stopped." note from the stop command.

### E4. A child stopped another way

Before: an admin stops child C1 from the dashboard. P is still running.

1. `stop(C1)` sets the stop time on C1 and its children only.
2. C1's `finishTurn` sends P a result with `outcome: "stopped"` (Decided),
   because P has no newer stop time.
3. Had P used `stopAgent`, P would get no result (Decided).

### E5. A forged result

Before: a bug in core calls send() for conversation X with a `source:
"agent"` record whose `sentBy` turn row is in C, a child of P, not of X.

1. X's worker runs `selectTurnInput`. The `sentBy` turn row is not in a
   child of X.
2. The record is dropped with reason `sender_mismatch` (P26). No turn.

There is no message that points at a record in another conversation, so
there is no record-match check (rule 10).
