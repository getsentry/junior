# Interfaces: Child Agents And Plugin-Started Agents

Sketches for review, not final code. Labels follow `../design.md`.

## Asking A Child

```ts
/**
 * spawnAgent. Under the SQL parent lock: check the caps (8 children with open
 * work, 4 open requests per child), create the child conversation and its
 * binding, and save the request record. Then release the lock and send.
 * Keyed by parent turnId + toolCallId, so a retried tool call is a no-op.
 */
function spawnAgent(
  parentTurn: TurnRecord,
  args: { toolCallId: string; name?: string; task: ChildTask },
): Promise<{ conversationId: ConversationId; requestId: RequestId }>;

/**
 * messageAgent to a child. Saves a request record with replyTo parent and
 * sends one message. Never starts a runner. The child's join rule decides
 * whether it joins a running turn.
 */
function messageChild(
  parentTurn: TurnRecord,
  args: {
    toolCallId: string;
    childConversationId: ConversationId;
    text: string;
  },
): Promise<{ requestId: RequestId; delivery: "joined_or_waiting" }>;
```

Both create a request record with:

- `actor` and `credentialSubject` from `parentTurn` (P15);
- `onBehalfOf`: the parent turn's starting request id;
- `replyTo: { kind: "parent", parentConversationId, toolCallId }`.

`maxAgentDepth` defaults to 1 (Decided). A child can start its own children,
one level down. Those cannot start more.

## Child Results

```ts
/**
 * The one message a child turn sends to its parent, at finishTurn. One per
 * distinct parent reply target, even when the turn took in several requests.
 * Its id is fixed: turnId + parent, so a resumed finishTurn sends it once.
 */
type ChildResultMessage = InboundMessage & {
  source: "agent";
  delivery: "wait";
  /**
   * The request record this result answers (the one the parent made). The
   * receiving turn acts for its actor (P15). Its replies go to the reply
   * target of that record's onBehalfOf, or to the conversation's default
   * when onBehalfOf is an inline request (P6).
   */
  requestId: RequestId;
  result: {
    childConversationId: ConversationId;
    title: string;
    /** Every request this turn answered. */
    answers: RequestId[];
    /** True when the request was already answered by an earlier turn (P6). */
    followUp: boolean;
    outcome: "completed" | "failed" | "blocked" | "stopped" | "no_reply";
    /** The child's last assistant response, capped at 12,000 characters. */
    text?: string;
    /** Siblings whose results have not arrived, so the parent waits. */
    pendingSiblings: ConversationId[];
  };
};
```

A result never joins a running parent turn. It waits for the event wait
window, so sibling results share a turn. It skips the automated-turn check
but counts toward it (Decided).

## Plugin-Started Agents

```ts
/** Create one run. Keyed by plugin + idempotency key (or taskId + scheduledForMs). */
function startPluginAgent(args: {
  plugin: string;
  idempotencyKey: string;
  location: Location;
  instruction: string;
  credentialSubject?: SignedCredentialSubject;
  replyTo:
    | { kind: "automation_run"; automationRunId: string }
    | { kind: "plugin"; plugin: string };
}): Promise<{ id: RequestId; created: boolean }>;

/** What a plugin sees (P21). Status is computed from the request record. */
type PluginAgentView = {
  id: RequestId;
  status: "running" | "completed" | "failed" | "blocked";
  resultMessageTs?: string;
  errorMessage?: string;
};
```

## Examples

### E1. Busy child: a message joins, one result covers both

Before: child C runs turn T1 for request `r1` (actor A, A's access). The
parent P sends `messageChild` (request `r2`, actor A, same access).

1. `send(m2)` puts `m2` in C's inbox. C's policy is `join_now_or_wait`.
2. At T1's next safe point, `canJoin(T1, m2)` is true. `saveCheckpoint` adds
   `r2` to `T1.requestIds`, then removes `m2` from the inbox.
3. T1 ends. `finishTurn` sends one `ChildResultMessage` to P with
   `answers: [r1, r2]`. Both records become `answered`.

If `r2` had actor B: `canJoin` is false, `m2` waits, and T2 runs for B with
its own result (Decided).

### E2. Grandchild result after the child's turn ended

Before: P's turn (for A) asked child C (`r1`). C's turn T1 spawned
grandchild G (`r2`: actor A, `onBehalfOf: r1`, replyTo C).

1. T1 ends before G. `finishTurn` sends P a result for `r1`. `r1` is
   `answered`.
2. G finishes. Its result message goes to C's inbox with `requestId: r2`.
3. C starts T2. T2 acts for `r2.actor`, which is A (P15). T2's reply target
   is `r1.replyTo` (through `onBehalfOf`), so P gets a second message for
   `r1` with `followUp: true` (P6).
4. P starts a new turn for A with the follow-up.

If B messaged C between steps 1 and 2, nothing changes: T2 still acts for A,
because it reads `r2`, not the latest request.

### E3. Top-level stop of a tree

Before: P (top-level) runs T for A. Children C1 (running) and C2 (idle, one
open request). C1 has grandchild G (running).

1. A clicks stop. `stop(P, person)` saves a stop request on T. It walks
   `parentConversationId` down: saves stop requests on the open turns of C1
   and G, and marks every open request record in the tree `stopped`.
2. Each worker sees its stop at the next safe point and calls `finishTurn`
   with `stopped: tree`. No results go up: every reply target in the tree is
   a `stopped` request.
3. A child result that arrives later for a `stopped` request is dropped
   (bug 13).
4. P's Slack thread gets the "Stopped." note from the stop command.

### E4. A child stopped another way

Before: an admin stops child C1 from the dashboard. P is still running.

1. `stop(C1, person)` stops C1's turn and C1's own children.
2. C1's `finishTurn` sends P a result with `outcome: "stopped"` (Decided).
3. If P had stopped C1 with `stopAgent`, P gets no result (Decided).
