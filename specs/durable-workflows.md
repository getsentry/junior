# Durable Slack Thread Workflows Spec

## Status

Accepted

## Source

- Issue: <https://github.com/getsentry/junior/issues/67>

## Related Specs

- [Harness Agent Spec](./harness-agent-spec.md)
- [Logging Spec Index](./logging/index.md)
- [Tracing Spec](./logging/tracing-spec.md)
- [Security Policy](./security-policy.md)

## Context

Two Slack messages can arrive in the same thread while the first turn is still running (typically 10-30 seconds). Chat SDK currently executes `handleIncomingMessage`, which sets a dedup key before lock acquisition. If lock acquisition fails, the second message is dropped because dedup has already been consumed.

Current behavior is incorrect for long-running agent turns. We need deterministic per-thread serialization and durable resumption across crashes/deploys without custom lock infrastructure.

## Audit Summary (What Was Missing Before)

The previous spec described architecture direction but did not define an implementation contract for:

- Exact ingress and routing algorithm (including race semantics).
- Data contracts for payload shape and dedupe keying.
- Retry and idempotency semantics for side-effecting Slack turns.
- Failure handling so one bad message does not kill a thread workflow.
- Observability event/span contract and required attributes.
- Rollout/rollback and measurable acceptance criteria.

This revision closes those gaps.

## Goals

1. Eliminate silent message loss for concurrent messages in one Slack thread.
2. Guarantee in-order processing per thread.
3. Preserve existing business logic in `appSlackRuntime` and `bot.ts`.
4. Keep Slack UX unchanged, including streaming via `AsyncIterable<string>` to `thread.post(...)`.
5. Keep migration as hard cutover with no feature flag.

## Non-Goals

1. Rewriting `prepareTurnState`, routing classifier prompts, or reply generation logic.
2. Changing non-message event handling (`reaction`, `action`, `modal`, `slash`, assistant lifecycle, app home).
3. Making eval harness use Workflow runtime directly in this phase.

## Design Constraints

1. Workflow implementation uses `workflow@4.1.0-beta.60`.
2. Next.js config must be wrapped with `withWorkflow()` so `"use workflow"` and `"use step"` are transformed.
3. Workflow functions stay orchestration-only; Node.js work runs in steps.
4. Chat SDK objects cross workflow boundaries via `@workflow/serde`.
5. `ThreadImpl.fromJSON` and `WORKFLOW_DESERIALIZE` require a registered Chat singleton.

## Architecture

### Current Flow

```text
Slack Event -> Webhook -> Chat SDK processMessage (patched)
  -> handleIncomingMessage (dedup + lock + handler dispatch)
  -> onNewMention / onSubscribedMessage -> replyToThread -> agent loop
```

### Target Flow

```text
Slack Event -> Webhook -> processMessage (patched, new behavior)
  -> Normalize thread ID
  -> Determine kind (new_mention | subscribed_message | skip)
  -> Ingress dedup claim (Redis SET NX)
  -> Route to workflow (resume-or-start)
    v
slackThreadWorkflow(threadId):
  for await (payload of messageHook) {
    processThreadMessage(payload)  // "use step"
      -> appSlackRuntime.handleNewMention / handleSubscribedMessage
        -> existing pipeline unchanged (prepare -> classify -> reply -> stream -> persist)
  }
```

## Boundary Contract

### Chat SDK Boundary

1. We do not change `appSlackRuntime` public behavior. Workflow ingress only decides `kind` and forwards to existing handlers.
2. `onNewMention` semantics remain "only for unsubscribed mentions".
3. `onSubscribedMessage` semantics remain "all subscribed-thread messages", including mentions.
4. Mention detection order is fixed: `message.isMention` first, then `detectMention(...)` fallback.
5. Streaming contract is unchanged: handlers still pass `AsyncIterable<string>` to `thread.post(...)`.

### Workflow Boundary

| Concern | Lives In Workflow Function (`"use workflow"`) | Lives In Step (`"use step"`) |
|---------|-----------------------------------------------|------------------------------|
| Hook creation and async message loop | ✅ | ❌ |
| In-loop dedupe memory (`Set`) | ✅ | ❌ |
| Slack/business side effects | ❌ | ✅ |
| Chat singleton registration | ❌ | ✅ |
| Attachment fetcher rehydration | ❌ | ✅ |
| Runtime handler dispatch (`appSlackRuntime.*`) | ❌ | ✅ |

### Direct Step Invocation Requirement

1. Workflow code must call step functions directly.
2. Do not route step execution through callback/config abstraction layers from workflow code.
3. Keep step wrappers in separate modules so workflow files only import explicit step entrypoints.
4. This rule prevents workflow bundling from traversing Node-dependent application graphs as workflow-context code.

## Invariants

1. One active workflow run per normalized Slack thread ID.
2. Each accepted payload for a thread is processed sequentially.
3. A single message should result in at most one turn invocation in normal conditions.
4. A step failure must not terminate the workflow loop for that thread.
5. Explicit mention behavior remains deterministic via `message.isMention`.

## Data Model

### Thread Identity

- Canonical thread ID format: `slack:<channel_id>:<thread_ts>`.
- `normalizeIncomingSlackThreadId(...)` remains source of truth.
- Hook token equals canonical thread ID.

### Payload Contract

```ts
export type ThreadMessageKind = "new_mention" | "subscribed_message";

export interface ThreadMessagePayload {
  dedupKey: string; // `${normalizedThreadId}:${message.id}`
  kind: ThreadMessageKind;
  message: Message; // chat Message with @workflow/serde
  normalizedThreadId: string;
  thread: Thread; // chat Thread with @workflow/serde
}
```

### Dedupe Keys

- Ingress key: `workflow_ingress:${normalizedThreadId}:${message.id}`.
- Ingress TTL: 5 minutes.
- Workflow in-memory key: `payload.dedupKey`.
- Workflow dedupe set cap: 500 keys; evict oldest half when exceeded.

## End-to-End Algorithm

### A. Ingress (`chat-background-patch.ts` `processMessage`)

1. Resolve message factory.
2. Normalize Slack thread ID.
3. Skip self messages (`message.author.isMe`).
4. Determine route kind:
5. If `stateAdapter.isSubscribed(threadId)` is `true`, use `subscribed_message`.
6. Else if `message.isMention` is `true`, use `new_mention`.
7. Else if `detectMention(...)` is `true`, use `new_mention`.
8. Else return (non-subscribed non-mention).
9. Atomically claim ingress dedupe key with Redis `SET key value NX PX ttl`.
10. If dedupe claim fails, return early.
11. Build `ThreadMessagePayload`.
12. Call router `routeToThreadWorkflow(threadId, payload)`.
13. On router error, log and rethrow so background task logs capture failure.

### B. Router (`src/chat/workflow/router.ts`)

```ts
export async function routeToThreadWorkflow(threadId, payload) {
  const resumed = await tryResume(threadId, payload); // fast path
  if (resumed) {
    return;
  }

  try {
    await start(slackThreadWorkflow, [threadId]); // create run if absent
  } catch (startError) {
    // allowed race: another process started it first
    // hook-conflict and already-started races are non-fatal here
  }

  await retryResume(threadId, payload); // bounded retries with backoff
}
```

Resume miss is defined as either:

- `resume(...)` throws (missing hook token / stale token / transport error).
- `resume(...)` returns an empty result.

Router retry policy:

- Attempts: 5 total.
- Backoff: 50ms, 100ms, 200ms, 400ms.
- On final failure: emit `workflow_route_failed` and throw.

Start/resume state machine:

1. Try `resume` once (hot path).
2. If miss, call `start`.
3. Ignore `start` races/conflicts and continue.
4. Retry `resume` with bounded backoff.
5. If all retries fail, throw and emit `workflow_route_failed`.

### C. Workflow (`src/chat/workflow/thread-workflow.ts`)

```ts
export async function slackThreadWorkflow(threadId: string) {
  "use workflow";
  const hook = threadMessageHook.create({ token: threadId });
  const { workflowRunId } = getWorkflowMetadata();
  await processThreadPayloadStream(hook, workflowRunId);
}
```

### D. Step (`thread-steps.ts`)

Rules:

1. Keep step code in explicit step functions:
   - `processThreadMessageStep(...)`
   - `logThreadMessageFailureStep(...)`
2. Mark step functions with `"use step"`.
3. Set `processThreadMessageStep.maxRetries = 1`.
4. Dynamically import `@/chat/bot` and call `bot.registerSingleton()`.
5. Rehydrate attachment `fetchData` from `url` before runtime call.
6. Dispatch by `kind` to `appSlackRuntime`.

Attachment rehydration contract:

- `Message.toJSON()` strips `attachment.data` and `attachment.fetchData`.
- Reattach `fetchData` with `downloadPrivateSlackFile(attachment.url)` for each attachment that has a URL and lacks `fetchData`.

## Retry And Idempotency Semantics

1. Ingress dedupe is at-most-once for short duplicate windows.
2. Step retries are intentionally bounded to one retry because turns have visible Slack side effects.
3. Residual risk: one duplicate reply can still occur on retry after an ambiguous failure.
4. Tradeoff is accepted for v1; if duplication becomes operationally significant, add turn-level persisted idempotency markers in thread state keyed by `message.id`.

## Failure Model

1. Resume/start race: handled by resume-first then bounded retry after start.
2. Hook token conflict: treated as benign race; retry resume.
3. Single message processing failure: logged, workflow continues.
4. Workflow crash outside message loop: next message triggers start path and recreates loop.
5. Attachment download failure: runtime behavior remains unchanged (existing warning path).

## Observability Contract

Use existing logging/tracing conventions from `specs/logging/*`.

Required event names:

- `workflow_ingress_dedup_hit`
- `workflow_ingress_enqueued`
- `workflow_route_start_attempt`
- `workflow_route_resume_retry`
- `workflow_route_failed`
- `workflow_message_failed`

Required span boundaries:

- `workflow.route_message` (`op: workflow.route_message`)
- `workflow.thread_message` (`op: workflow.thread_message`)
- Existing `workflow.chat_turn` and `workflow.reply` remain unchanged

Required correlation attributes when available:

- `messaging.system`
- `messaging.message.conversation_id`
- `messaging.message.id`
- `messaging.destination.name`
- `enduser.id`
- `app.workflow.run_id`

## File-Level Change Plan

| File | Change |
|------|--------|
| `next.config.ts` | Wrap Next config with `withWorkflow()` before `withSentryConfig(...)`. |
| `src/chat/bot.ts` | Register Chat singleton at construction-time (with test-safe compatibility for mocked Chat instances). |
| `src/chat/state.ts` | Expose helper for atomic ingress dedupe claim using Redis `SET NX`. |
| `src/chat/workflow/types.ts` | Add payload contract types. |
| `src/chat/workflow/thread-workflow.ts` | Keep workflow-only orchestration: hook definition, dedupe loop, direct calls to explicit step functions. |
| `src/chat/workflow/thread-steps.ts` | Add all step IO: singleton registration, attachment rehydration, runtime dispatch, and failure logging. |
| `src/chat/workflow/router.ts` | Add resume-or-start router with bounded retry. |
| `src/chat/chat-background-patch.ts` | Replace `handleIncomingMessage` call path in `processMessage` with routing algorithm above. |
| `tests/unit/workflow/router.test.ts` | Unit tests for resume/start race paths and retry behavior. |
| `tests/integration/workflow/thread-workflow.test.ts` | Validate orchestration ordering/dedupe/keep-alive behavior through real runtime step execution with fake agent output only. |
| `tests/integration/workflow/thread-step-boundaries.test.ts` | Validate step-level Slack/runtime side effects through real runtime wiring. |
| `tests/integration/slack/chat-background-routing.test.ts` | Extend with routing classification and dedupe coverage. |

## Verification Plan

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm evals`
4. Manual Slack test: send two rapid messages in one thread while first turn is running; both must be processed.
5. Manual Slack test: message with image/file attachment still resolves via `fetchData`.
6. Inspect logs/traces for new routing events and correlation attributes.

## Rollout And Rollback

Rollout:

1. Deploy as hard cutover (single code path).
2. Watch `workflow_route_failed` and `workflow_message_failed` after deploy.
3. Confirm no increase in duplicate replies and no dropped-conversation reports.

Rollback:

1. Revert `processMessage` routing to `handleIncomingMessage(...)`.
2. Keep workflow files dormant; no runtime traffic once ingress path is reverted.
3. Redeploy and verify message handling reverts to prior behavior.

## Acceptance Criteria

1. No silent drop in reproduced contention scenario (two rapid messages in one thread).
2. Messages in same thread are processed in arrival order.
3. Existing subscribed-thread mention bypass behavior is preserved.
4. Streaming UX remains incremental in Slack.
5. Test suite and eval suite pass without regressions.

## Risks

| Risk | Mitigation |
|------|------------|
| Step retry can emit duplicate user-visible output | `maxRetries = 1`; monitor and add persisted idempotency guard if needed |
| Router failure in background path can still lose a message | bounded retry and explicit error telemetry |
| Workflow SDK beta behavior changes | keep business logic outside workflow; workflow layer remains coordination-only |
| Long-lived workflow run growth over time | accepted for v1; monitor run volume and add idle shutdown policy if needed |
