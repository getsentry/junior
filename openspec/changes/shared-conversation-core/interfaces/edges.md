# Interfaces: How Kinds Differ (Data, Not Callbacks)

Sketches for review, not final code. Labels follow `../design.md`.

An early version of #2499 passed seven per-kind callbacks into a shared
layer and kept the copies. It was dropped before merge. Here the core takes no per-kind callbacks. Each kind differs in three
stored things, and per-kind code runs only at two edges.

| Stored once                  | Where                              | Read by                             |
| ---------------------------- | ---------------------------------- | ----------------------------------- |
| `ConversationPolicy`         | conversation row, at create        | `canJoin`, `send`, `pauseForSignIn` |
| `actor`, `credentialSubject` | request record (or inline request) | turn start, `credentialsForTurn`    |
| `replyTo`                    | request record (or inline request) | `deliver`, `finishTurn`             |

## Edge 1: Ingress

Each source turns its own format into one `InboundMessage`. It decides
admission (who may send) before `send()`. It never runs work.

```ts
/**
 * Slack, web, ACP, CLI, events and parent agents each have one of these.
 * A drop is recorded with its reason. "create_request" goes through
 * createRequest (inbox.md); "send" carries an inline request.
 */
type Ingress<Raw> = (raw: Raw) => Promise<IngressResult>;

type IngressResult =
  | { kind: "send"; message: InboundMessage }
  | {
      kind: "create_request";
      record: Omit<RequestRecord, "status" | "createdAtMs">;
      message: InboundMessage;
    }
  | { kind: "stop"; conversationId: ConversationId; by: StopBy }
  | { kind: "drop"; reason: "not_admitted" | "untrusted_author" | "ignored" };
```

A stop command returns `stop`. It never enters the inbox.

## Edge 2: Delivery

One plain object per reply target kind. The core picks it by
`replyTo.kind`. It posts what the core gives it and nothing else.

```ts
/**
 * Post one response to one reply target. Provider code owns formatting and
 * provider errors. The core owns when to post and what to post.
 */
type ReplyTargetAdapter = {
  kind: ReplyTarget["kind"];
  /** Post with deliveryId attached, so find() can see it later. */
  post(
    target: ReplyTarget,
    delivery: Delivery,
    body: ResponseBody,
  ): Promise<{ providerMessageId?: string }>;
  /** After a lost worker: did a post with this deliveryId already land? */
  find(
    target: ReplyTarget,
    deliveryId: string,
  ): Promise<{ providerMessageId: string } | undefined>;
};

const replyTargets: Record<ReplyTarget["kind"], ReplyTargetAdapter>;
```

- `location`: Slack post in the thread. `find` reads message metadata.
- `stored`: no post. History is the delivery. `find` reads history.
- `parent`: `send()` to the parent inbox. `find` is the inbox duplicate check.
- `automation_run`: posts the declared outcomes in order (P18).
- `plugin`: saves the result message id on the request record.

`ResponseBody` is either an assistant response, a runtime error message, a
runtime ending note, or a child result. The adapter cannot tell a turn to
retry, stop or join. That is why this is not #2499.

## The CLI

`pnpm cli -- chat` builds an `InboundMessage` with `source: "cli"` and an
inline request (local CLI user, reply target `stored`). It calls `send()`,
then runs `work()` in the same process with the local store, until the
conversation has no runnable work. The terminal prints new history items.
Same dedupe, batching and join rules as other kinds (Decided).

## Examples

### E1. One Automation run, two outcomes, second post fails

Before: run R for Automation X. `replyTo: automation_run`. Outcomes:
`current_conversation` then `task_creator`.

1. The agent calls `finishAutomationRun(send_message, "Report")`.
2. `deliver` saves intent `d1` (thread) and posts it. Saves `sent`.
3. It saves intent `d2` (creator DM). The post fails with a retryable error.
   The turn pauses `post_retry`.
4. The next attempt finds `d1` `sent`, so it skips it. It calls
   `find(d2)`: not found. It posts `d2`.

After: each outcome is posted once. The request record is `answered`,
`completed`.

### E2. Event from an untrusted author

Before: a watched PR gets a comment from an account with no verified
identity.

1. The GitHub ingress reads the author. Trust check fails.
2. It returns `drop: untrusted_author` (P19). No request record, no inbox
   entry, no turn.

The same comment from a verified trusted author becomes an event message.
Its turn runs as the system actor, with access only from the Watch grant.

### E3. Web and Slack differ only in data

A web message and a Slack mention from the same person in two
conversations:

|                | Web                                                   | Slack                                     |
| -------------- | ----------------------------------------------------- | ----------------------------------------- |
| policy         | `web`, `canAskUser`, `join_now`, `wait`               | `slack`, `canAskUser`, `join_now`, `wait` |
| inline request | person, `stored`                                      | person, `location`                        |
| failed turn    | error message saved to history; message marked failed | error message posted in the thread        |

Both run the same `work()` and `finishTurn`. Only `replyTargets[kind]`
differs.
