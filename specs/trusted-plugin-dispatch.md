# Trusted Plugin Dispatch Spec

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-05-28

## Purpose

Define the durable `ctx.agent.dispatch` primitive used by trusted plugins to ask Junior core to run an autonomous agent request later or outside the interactive Slack turn.

## Scope

- Plugin-facing dispatch API.
- Core-owned dispatch callback endpoint.
- Dispatch state, recovery, locking, continuation, and delivery idempotency.
- System actor and auth restrictions for dispatched agent runs.

## Non-Goals

- Trusted plugin heartbeat mechanics; see [Trusted Plugin Heartbeat Spec](./trusted-plugin-heartbeat.md).
- Scheduler task semantics; see [Scheduler Spec](./scheduler.md).
- Interactive Slack turn handling; see [Slack Agent Delivery Spec](./slack-agent-delivery.md).

## Plugin API

Trusted plugins may dispatch an agent request:

```ts
const result = await ctx.agent.dispatch({
  idempotencyKey: run.id,
  destination: {
    platform: "slack",
    teamId: task.destination.teamId,
    channelId: task.destination.channelId,
  },
  input: buildScheduledTaskRunPrompt({ task, run, nowMs }),
  metadata: {
    taskId: task.id,
    runId: run.id,
  },
});
```

Argument shape:

```ts
type DispatchOptions = {
  idempotencyKey: string;
  destination: {
    platform: "slack";
    teamId: string;
    channelId: string;
  };
  input: string;
  metadata?: Record<string, string>;
};
```

Return value:

```ts
type DispatchResult = {
  id: string;
  status: "created" | "already_exists";
};
```

Plugins may read dispatch status they own:

```ts
const dispatch = await ctx.agent.get(dispatchId);
```

Projection:

```ts
type Dispatch = {
  id: string;
  status:
    | "pending"
    | "running"
    | "awaiting_resume"
    | "completed"
    | "failed"
    | "blocked";
  resultMessageTs?: string;
  errorMessage?: string;
};
```

`ctx.agent.get(id)` returns only dispatches owned by the calling trusted plugin. It omits prompt text, destination details, actor details, metadata, conversation state, tool calls, model messages, logs, and credentials.

## Dispatch Constraints

- `idempotencyKey` is required.
- Same plugin + idempotency key must not create two dispatch records.
- `destination.platform` must be `"slack"`.
- Destination must be a Slack public channel, private channel, or existing DM channel the bot can post to.
- Destination must not be an existing Slack thread.
- Destination uses a Slack channel id; it must not accept a user id.
- Input is plain text inserted as user-role synthetic conversation content.
- Metadata is correlation-only and must not affect authorization.
- System dispatches have no requester, no user OAuth token access, and no interactive auth continuation.
- Schedule-management tools are unavailable during system dispatches.

Core derives and enforces system actor identity, auth mode, conversation identity, callback scheduling, timeout continuation, sandbox state persistence, delivery behavior, tool policy, logging, tracing, and redaction.

## Internal Callback

`agent.dispatch` persists a core-owned dispatch record, then fires a signed internal callback:

```txt
POST /api/internal/agent-dispatch
```

The endpoint is core-owned. Plugins must not register dispatch routes, choose callback URLs, or receive the raw callback `Request`.

Core callback behavior:

1. Persist dispatch metadata and expected version in durable state.
2. Sign a small callback envelope containing dispatch id and expected version.
3. Verify callback signature and timestamp.
4. Load and claim the dispatch record.
5. Run one bounded execution slice.
6. Persist result, retry state, blocked state, or continuation state.

Heartbeat auth and dispatch callback auth are separate. `/api/internal/heartbeat` uses cron auth; dispatch callbacks use HMAC body signing with timestamp skew checks.

## Dispatch State

Core dispatch state is separate from plugin state. Plugin state records that domain work was dispatched; core records whether the agent request ran and delivered output.

Stored dispatch records include:

- id
- plugin
- idempotency key
- status: `pending | running | awaiting_resume | completed | failed | blocked`
- version
- system actor
- Slack destination
- input
- metadata
- timestamps
- attempt/max attempt fields
- lease and session continuation fields
- result timestamp or error message

Plugin-visible `Dispatch` is a projection, not the stored record.

Dispatch ids should be deterministic from plugin name and idempotency key. Duplicate calls return the existing dispatch id and may re-fire the callback only when the record is incomplete.

Dispatch records use Junior's one-week thread-state TTL. `ctx.agent.get(id)` is reconciliation, not permanent run history.

## Recovery

Core owns recovery for incomplete dispatches. The heartbeat endpoint performs bounded core recovery before invoking plugin heartbeat handlers.

Core may re-fire a signed dispatch callback for incomplete stale states:

- `pending` with no recent callback attempt
- `running` with an expired lease
- `awaiting_resume` with an expired lease or missing callback attempt

Core must not re-fire terminal states: `completed`, `failed`, or `blocked`.

Recovery is bounded by attempt count, max dispatch age, max continuation slices, and retention. A dispatch that exceeds retry bounds is marked `failed`.

## Locking And State Transitions

Dispatch mutation uses existing state adapter locks.

Lock order is always:

1. `dispatch:<id>`
2. destination conversation lock

Code must not acquire those locks in reverse order. Stale recovery uses durable status, version, attempt, and lease fields rather than process memory.

Dispatch leases are not renewed during a slice. Lease duration must exceed the maximum callback slice budget plus platform scheduling slack.

## Runner

The internal callback runs a core-owned dispatched agent runner. The runner owns:

- loading and claiming the dispatch record
- acquiring the destination conversation lock
- loading persisted conversation, artifact, sandbox, and channel config state
- creating or reusing synthetic system-authored conversation messages
- building conversation context
- calling `generateAssistantReply`
- delivering the reply
- committing conversation, artifact, sandbox, and dispatch state
- marking auth-required runs as blocked
- scheduling continuation after resumable timeout

Plugins never see this runner or its dependencies.

## Delivery Idempotency

Callbacks are at-least-once. Visible delivery is best-effort exactly once.

The runner must use stable synthetic message ids:

- `dispatch:${dispatch.id}:user`
- `dispatch:${dispatch.id}:assistant`

Before posting, the runner checks persisted conversation state for the assistant message id. If it already has `meta.replied === true` and `meta.slackTs`, the runner marks dispatch `completed` with that Slack timestamp and does not post again.

Slack post and state commit are not atomic. If Slack accepts the post but persisting completion state fails, retry checks persisted conversation state before posting again, but duplicate suppression remains best-effort for that failure window.

## Continuation

Dispatched requests must not use the interactive Slack turn-resume route. Timeout continuation uses the dispatch callback path:

1. `generateAssistantReply` persists a resumable session record for the dispatch conversation and turn id.
2. Runner catches `turn_timeout_resume`.
3. Runner marks dispatch `awaiting_resume` with the next record version.
4. Runner signs another callback for the same dispatch id.
5. Next callback verifies expected state/version.
6. Runner resumes with the same dispatch input, conversation id, turn id, actor, destination, and persisted Pi messages.
7. Final callback delivers once and marks dispatch `completed`, `failed`, or `blocked`.

Continuation invariants:

- one stable conversation id and one stable turn id per dispatch
- turn id derived from dispatch id
- duplicate callbacks must not run the same dispatch concurrently
- duplicate callbacks must not deliver assistant output twice
- timeout continuation preserves cumulative usage and duration
- auth continuation is disabled for system actors; auth-required outcomes become blocked

## Limits

Core enforces:

- maximum dispatch calls per heartbeat context
- maximum dispatch input length
- maximum metadata keys and bytes
- maximum concurrent dispatches per destination
- maximum retry attempts
- maximum dispatch age
- maximum continuation slices

## Failure Model

- Dispatch call fails: plugin keeps domain run pending/claimed and may reclaim after its stale timeout.
- Dispatch succeeds but callback does not complete: core recovery re-drives bounded incomplete dispatches.
- Dispatch blocks for auth: system actors do not start interactive auth; core persists a blocked result.
- Dispatch expires: `ctx.agent.get(id)` returns `undefined`, and plugin-owned history must reconcile terminal or redispatch policy.

## Observability

Dispatch logs should include:

- dispatch id
- plugin name
- idempotency key
- actor type/id
- destination platform and conversation id
- safe plugin metadata keys
- outcome

Recovery logs should include stale re-drive, retry bound exceeded, expiration before completion, and missing/expired lookup results.

Logs and spans must not include OAuth tokens, provider credentials, raw auth URLs, Slack tokens, prompt text, private tool payloads, or raw conversation state.

## Verification

Use integration tests for:

- `agent.dispatch` idempotency
- `agent.get` returns only caller-owned dispatch projections
- `agent.get` omits hidden dispatch fields
- internal callback signature verification
- stale core dispatch recovery bounded separately from plugin heartbeat work
- expired lookup behavior
- system actor dispatch does not use requester OAuth or interactive auth

Use unit tests for:

- dispatch input validation
- internal callback signing and parsing
- lock ordering and state transition helpers

## Related Specs

- `./trusted-plugin-heartbeat.md`
- `./scheduler.md`
- `./agent-session-resumability.md`
- `./chat-architecture.md`
- `./slack-agent-delivery.md`
