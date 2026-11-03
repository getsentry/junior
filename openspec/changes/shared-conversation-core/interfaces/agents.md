# Interfaces: Child Agents And Plugin-Started Agents

Sketches for review, not final code. Labels follow `../design.md`.

## Asking A Child

```ts
/**
 * spawnAgent and messageAgent both call this. One SQL transaction under the
 * parent conversation row (FOR UPDATE): refuse if the parent turn is
 * under the parent's stop (P34); check the caps (8 children with open work,
 * 4 open records per child); create the child conversation and binding if
 * new; insert the request record. Commit, then send(). Keyed by parent
 * turnId + toolCallId, so a retried tool call returns the first result.
 * Never starts a runner.
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
- `replyTo: { kind: "parent", responses: "result", parentConversationId,
toolCallId }`.

`maxAgentDepth` defaults to 1 (Decided): a child can start children, one
level down.

```ts
/**
 * A child's message to its parent, without ending its turn. Needs an open
 * record on the child's current turn. One fenced save in the child mints a
 * record in the parent (`answers`: the turn's open records for this
 * parent; `sentBy`: this turn), then send() follows. Acts for that turn's
 * actor. Marked as not from a person.
 */
function messageParent(
  childTurn: TurnRecord,
  text: string,
): Promise<SendResult>;
```

## Child Results

```ts
/**
 * The one message a child turn sends per parent reply target, at
 * finishTurn. Its id is turnId + parent, so a resumed finishTurn sends it
 * once.
 */
type ChildResultMessage = InboundMessage & {
  source: "agent";
  join: "wait";
  /**
   * The result's own record in the parent, minted in the child's finishTurn
   * transaction (P26). Its `answers` and `sentBy` decide acceptance; the
   * fields below are display text only. The parent turn acts for the
   * answered record's actor (P15) and replies to its onBehalfOf's reply
   * target (P6).
   */
  requestId: RequestId;
  result: {
    childConversationId: ConversationId;
    title: string;
    /** Display copy of the record's `answers`. Not trusted. */
    answers: RequestId[];
    /** True when the record was already answered by an earlier turn (P6). */
    followUp: boolean;
    outcome: Outcome;
    /** The child's last assistant response, up to 12,000 characters.
     * Missing on "completed" means the child had nothing to say. */
    text?: string;
    /** Siblings whose results have not arrived, so the parent waits. */
    pendingSiblings: ConversationId[];
  };
};
```

The result record the child mints in the parent:

- `conversationId`: the parent; `inboundMessageId`: the result message id;
- `answers`: every record the child turn answered for this parent;
- `sentBy: { conversationId: child, turnId }`;
- `actor` and subject: those of the answered record (P15);
- `replyTo`: the reply target of the answered record's `onBehalfOf` (P6).

The parent's `selectTurnInput` accepts it only when the record matches the
message (rule 10), the `sentBy` turn row is in a child of the parent, and
every `answers` record has that child as `conversationId` and the parent as
`replyTo.parentConversationId` (P26).

A result never joins a running parent turn. It waits for the event window,
so sibling results share a turn. It skips the automated-turn check but
counts toward it (Decided).

## Plugin-Started Agents

```ts
/**
 * Create one run. The actor is always { platform: "system", name: plugin };
 * a plugin cannot pass an actor. The plugin passes an unbound subject; core
 * binds and signs it (P17). Keyed by plugin + idempotency key, or
 * taskId + scheduledForMs for Automations.
 */
function startPluginAgent(args: {
  plugin: string;
  idempotencyKey: string;
  location: Location;
  instruction: string;
  subject?: UnboundCredentialSubject;
  replyTo:
    | { kind: "location"; responses: "each" }
    | {
        kind: "automation_run";
        responses: "declared";
        automationRunId: string;
      };
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

1. `send(m2)` puts `m2` in C's inbox. C's `joinRule` is `now_or_wait`.
2. At T1's next safe point, `canJoin(T1, m2)` is true. `saveCheckpoint`
   adds `req_2` to `T1.requestIds`, then removes `m2` from the inbox.
3. T1 ends. `finishTurn` mints one result record in P with `answers:
[req_1, req_2]` and sends one `ChildResultMessage`. Both records become
   `answered`.

If `req_2` had actor B: `canJoin` is false, `m2` waits, and T2 runs for B
with its own result (Decided).

### E2. Grandchild result after the child's turn ended

Before: P's turn (for A, started by Slack record `req_s`) asked C (`req_1`,
`onBehalfOf: req_s`). C's turn T1 asked grandchild G (`req_2`: actor A,
`onBehalfOf: req_1`, `replyTo` parent C).

1. T1 ends before G. P gets a result for `req_1`. `req_1` is `answered`.
2. B messages C at 12:05 (`req_3`, actor B). T2 runs for B and ends.
3. G finishes. Its `finishTurn` mints `req_r` in C (`answers: [req_2]`,
   `sentBy`: G's turn) and sends the result. C checks: `req_r` matches the
   message; the `sentBy` turn row is in G, a child of C; `req_2` has
   `conversationId` G and `replyTo.parentConversationId` C. Accepted.
4. C starts T3 for `req_2.actor`, A (P15). B's 12:05 message is from
   another actor, so T3's model sees it marked as outside text, and it is
   not approval.
5. T3 replies to `req_1.replyTo`, which is P, with `followUp: true` (P6).
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
   after those records were made, so they mint no result records and no
   parent turn starts (P35).
5. P's Slack thread gets the "Stopped." note from the stop command.

### E4. A child stopped another way

Before: an admin stops child C1 from the dashboard. P is still running.

1. `stop(C1)` sets the stop time on C1 and its children only.
2. C1's `finishTurn` sends P a result with `outcome: "stopped"` (Decided),
   because P has no newer stop time.
3. Had P used `stopAgent`, P would get no result (Decided).

### E5. A forged result

Before: conversation X receives a message with `source: "agent"` and
`requestId: req_9`. `req_9` is C's result record in P.

1. X's worker loads `req_9`: its `conversationId` is P, not X.
2. The message is dropped with reason `record_mismatch` (rule 10). No turn.

If the record were in X but its `sentBy` turn row were not in a child of X,
the drop reason would be `sender_mismatch`.
