# Interfaces: How Kinds Differ (Data, Not Callbacks)

Sketches for review, not final code. Labels follow `../design.md`.

An early version of #2499 passed seven per-kind callbacks into a shared
layer and kept the copies. It was dropped before merge. Here the core takes
no per-kind callbacks and has no branch on kind. Each kind differs in stored
data, and per-kind code runs only at two edges.

| Stored once                  | Where                       | Read by                             |
| ---------------------------- | --------------------------- | ----------------------------------- |
| `ConversationPolicy`         | conversation row, at create | `canJoin`, `send`, `pauseForSignIn` |
| `actor`, `credentialSubject` | request record              | `startTurn`, `credentialsForTurn`   |
| `replyTo`, `outcomes`        | request record              | `deliver`, `finishTurn`             |

## Edge 1: Ingress

Each source turns its own format into one record and one message. It
decides admission before `createRequest`. It never runs work.

```ts
/**
 * One per source. A drop is recorded with its reason. Only core person
 * ingress (Slack, web, ACP, CLI) can make a VerifiedPersonActor, so only
 * it can return a person actor (rule 12, P39). Event ingress always
 * returns the system actor.
 */
type Ingress<Raw> = (raw: Raw) => Promise<IngressResult>;

type IngressResult =
  | {
      kind: "create_request";
      record: Omit<
        RequestRecord,
        "requestId" | "status" | "repair" | "createdAtMs"
      >;
      message: Omit<InboundMessage, "requestId">;
    }
  | { kind: "stop"; conversationId: ConversationId; by: StopBy }
  | { kind: "drop"; reason: "not_admitted" | "untrusted_author" | "ignored" };
```

A stop command returns `stop`. It never enters the inbox. Plugins never get
an `Ingress`; they call `startPluginAgent`, which fixes the system actor.

## Edge 2: Delivery

One plain object per `replyTo.kind`. `deliver` looks it up by kind. The
kind fixes which bodies the target gets (P18); there is no separate
`responses` field. `deliver` does not branch on the kind of conversation.

```ts
/**
 * Post one response to one reply target. Provider code owns formatting and
 * provider errors. The core owns when and what to post.
 */
type ReplyTargetAdapter = {
  /** Post with deliveryId attached, so find() can see it later. */
  post(
    target: ReplyTarget,
    delivery: Delivery,
  ): Promise<{ providerMessageId?: string }>;
  /** After a lost worker: did a post with this deliveryId already land? */
  find(
    target: ReplyTarget,
    deliveryId: string,
  ): Promise<{ providerMessageId: string } | undefined>;
};

const replyTargets: Record<ReplyTarget["kind"], ReplyTargetAdapter>;

/** Pure. Which bodies a reply target gets (P18). */
function shouldPost(target: ReplyTarget, body: ResponseBody): boolean {
  if (target.kind === "parent") return body.kind === "child_result";
  return body.kind !== "child_result"; // location posts; stored saves
}

/** One adapter for Automation outcomes. finishTurn calls it once per
 * outcome, in order, with the run's one result (P18). */
const outcomeTarget: ReplyTargetAdapter;
```

- `location`: Slack post in the thread. `find` reads message metadata.
- `stored`: no post. History is the delivery, shown in the web and
  dashboard view. `find` reads history. An Automation run uses it.
- `parent`: `send()` to the parent inbox. `find` is the inbox duplicate
  check. A parent gets errors inside the child result, so it gets no
  separate error post.
- Outcomes: a record with `outcomes` gets its one result posted to each
  outcome Destination once. A `failed` or `stopped` run, `no_action` and
  `misconfigured` post nothing there; the run shows on the Automation.

`ResponseBody` is `assistant`, `error`, `ending_note` or `child_result`.
The adapter cannot tell a turn to retry, stop or join.

## The CLI

`pnpm cli -- chat` uses core person ingress with the local CLI user and
`replyTo: { kind: "stored" }`. It calls `createRequest`,
then runs `work()` in the same process with the local store, until the
conversation has no runnable work. The terminal prints new history items.
Same dedupe, batching and join rules as other kinds (Decided).

## Examples

### E1. One Automation run, two outcomes, second post fails

Before: run R. `replyTo: stored`. Outcomes: `current_conversation` then
`task_creator`.

1. The agent writes a draft (assistant text). It is saved to history and
   shows in the web view. Nothing is posted to Slack.
2. The run ends with the final response "Report", or with
   `finishAutomationRun(send_message, "Report")`. That is the result (P18).
3. `finishTurn` saves intent `d1` with the text and posts it to the
   Automation's Destination. Saves `sent`.
4. It saves `d2` (creator DM) with the text. The post fails, retryable.
   The turn stays `finishing` and backs off (P33).
5. The next attempt skips `d1` (`sent`), calls `find(d2)`: not found. It
   posts `d2`'s saved text.

After: each outcome is posted once. The record is `answered`, `completed`.

### E2. Event from an untrusted author

Before: a watched pull request gets a comment from an account with no
verified identity.

1. GitHub ingress reads the author. The trust check fails.
2. It returns `drop: untrusted_author` (P19). No record, no inbox entry.

From a verified trusted author, the comment becomes a record with the
system actor and the Watch grant. Its text is labeled outside text.

### E3. Web and Slack differ only in data

A web message and a Slack mention from the same person in two
conversations:

|             | Web                                        | Slack                                 |
| ----------- | ------------------------------------------ | ------------------------------------- |
| policy      | `canAskUser`, `joinRule: now`, `wait`      | `canAskUser`, `joinRule: now`, `wait` |
| record      | person, `stored`                           | person, `location`                    |
| failed turn | error message saved; message marked failed | error message posted in the thread    |

Both run the same `work()` and `finishTurn`. Only `replyTargets[kind]`
differs.
