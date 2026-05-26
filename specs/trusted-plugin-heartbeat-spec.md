# Trusted Plugin Heartbeat Spec

## Metadata

- Created: 2026-05-26
- Last Edited: 2026-05-26

## Changelog

- 2026-05-26: Clarified that trusted plugin tools own their model-facing descriptions/guidance and must not require plugin-specific core prompt rules.
- 2026-05-26: Clarified heartbeat recovery budgets, dispatch callback path, retention constant, lease semantics, destination shape, and lookup verification.
- 2026-05-26: Defined dispatch lookup retention and scheduler-owned terminal run history.
- 2026-05-26: Added dispatch recovery, result lookup, serverless slice, lock ordering, and system-actor security invariants.
- 2026-05-26: Specified dispatched agent request runner, continuation behavior, and cleaner JavaScript API names.
- 2026-05-26: Initial draft for trusted plugin heartbeat and agent dispatch.

## Status

Draft

## Purpose

Define the minimal trusted-plugin runtime surface needed to move scheduler behavior out of Junior core without exposing raw routes, platform internals, Slack clients, or agent execution internals to plugins.

The motivating consumer is a scheduler plugin that lets users create scheduled tasks, then uses a core-owned serverless heartbeat and agent dispatch primitive to execute due work later.

## Scope

- Trusted plugin heartbeat hook.
- Trusted plugin tool registration hook.
- Core-owned internal heartbeat endpoint.
- Core-owned durable agent dispatch primitive.
- Serverless continuation model for plugin-claimed work.
- Scheduler-as-plugin migration boundary.

## Non-Goals

- Manifest-only scheduler plugins.
- Plugin-defined routes.
- Per-plugin heartbeat URLs.
- Plugin-owned Vercel or deployment adapter behavior.
- Generic durable queue infrastructure.
- Arbitrary cron schedules per plugin.
- Raw Slack Web API access from plugins.
- Raw agent runtime or `generateAssistantReply` access from plugins.
- Raw state adapter or Redis access from plugins.

## Contracts

### Trust Boundary

Heartbeat and agent dispatch are trusted plugin capabilities. They are available only to Junior-owned built-in trusted plugins and plugins explicitly passed to `createApp({ plugins: [...] })` as trusted runtime plugins.

Declarative `plugin.yaml` manifests must not register heartbeat handlers, internal routes, or agent dispatch behavior.

Core owns:

- route registration
- internal route authentication
- deployment cron configuration
- trusted plugin lookup
- plugin state namespaces
- serverless continuation callbacks
- agent execution
- Slack delivery
- auth mode enforcement
- logging and redaction

Plugins own only their domain logic: tools, heartbeat work discovery, durable plugin state records, and the inputs they ask core to dispatch.

### Interactive Tool Registration

Trusted plugins may register turn-scoped tools through a narrow hook:

```ts
interface TrustedPluginHooks {
  tools?(ctx: ToolRegistrationContext): Record<string, ToolDefinition>;
}
```

`ToolRegistrationContext` exposes only the current turn context needed to
decide whether tools are available:

- active conversation destination, when present
- requester, when present
- channel/team identifiers, when present
- thread/message timestamps, when present
- namespaced plugin state
- current user text
- schedule-tool suppression for system dispatches

Tools returned by this hook participate in the normal tool pipeline: schema
validation, tool guidance, tracing, and plugin `beforeToolExecute` hooks.

Each returned tool must carry a concise model-facing description that explains
what the tool does and when it should be used. If correct use requires policy
that is specific to the plugin domain, such as destination scoping, confirmation
requirements, or recurrence semantics, that guidance belongs on the tool via
its description, schema descriptions, `promptSnippet`, or `promptGuidelines`.
Core prompt rules must stay plugin-agnostic and must not name scheduler tools or
any other specific plugin tool.

The built-in scheduler plugin uses this hook to register create/list/update/
delete/run-now tools only when the active Slack conversation has enough context
to manage scheduled tasks.

### Core Heartbeat Endpoint

Core exposes one internal heartbeat endpoint:

```txt
GET /api/internal/heartbeat
```

The endpoint is core-owned and deployment-owned. Plugins must not register heartbeat routes, choose heartbeat URLs, or receive the raw `Request`.

Core responsibilities:

1. Verify the request with the configured internal heartbeat secret.
2. Re-drive stale core dispatches within a bounded core recovery budget.
3. Enumerate trusted plugin heartbeat handlers.
4. Invoke handlers with a bounded `HeartbeatContext`.
5. Enforce a small per-handler and total plugin heartbeat budget.
6. Log core recovery and per-plugin outcomes.
7. Return a generic response that does not expose installed plugin details unnecessarily.

V1 uses one platform cron entry for this endpoint. The endpoint is a pulse, not a job runner.

### Heartbeat Hook

Trusted plugins may implement:

```ts
interface TrustedPluginHooks {
  heartbeat?(ctx: HeartbeatContext): Promise<HeartbeatResult | void>;
}
```

Heartbeat semantics:

- Serverless-triggered.
- Best effort.
- May run late.
- May be skipped.
- May run concurrently with another heartbeat invocation.
- May run more than once for the same wall-clock minute.
- Must be idempotent.
- Must process bounded work.
- Must persist progress in durable state.
- Must not rely on memory, timers, or process lifetime.

Core does not guarantee every heartbeat handler runs on every pulse. Durable state and idempotent claiming are the reliability boundary.

### Heartbeat Context

`HeartbeatContext` should stay minimal:

```ts
interface HeartbeatContext {
  nowMs: number;
  state: NamespacedState;
  agent: {
    get(id: string): Promise<Dispatch | undefined>;
    dispatch(options: DispatchOptions): Promise<DispatchResult>;
  };
  log: PluginLogger;
}
```

Do not expose `waitUntil` to trusted plugins in V1. Core may use platform lifetime extension internally, but plugin handlers should be written as bounded request handlers.

### Agent Dispatch

Trusted plugins may ask core to fire off an agent request:

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

The argument shape is:

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

The return value is:

```ts
type DispatchResult = {
  id: string;
  status: "created" | "already_exists";
};
```

Plugins may read the current state of a dispatch they created:

```ts
const dispatch = await ctx.agent.get(dispatchId);
```

The lookup return value is:

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

This is the only plugin-facing agent execution API for V1. Plugins do not call `runSystemTurn`, `generateAssistantReply`, Slack runner helpers, thread-state helpers, or delivery helpers.

If exported types are needed, prefer short JavaScript-facing names like `DispatchOptions`, `DispatchResult`, and `Dispatch`.

Core derives and enforces:

- system actor identity from the plugin name
- auth mode from the system actor
- no requester for system actors
- disabled interactive auth for system actors
- conversation state identity from destination
- delivery behavior from destination
- internal callback scheduling
- timeout continuation behavior
- sandbox state persistence
- tool availability policy
- tracing, logging, and redaction

`idempotencyKey` is required. Calling `agent.dispatch` with the same plugin and idempotency key must not create two dispatch records.

V1 dispatch constraints:

- `destination.platform` must be `"slack"`.
- The destination must be a Slack public channel, private channel, or existing DM channel that the bot can post to.
- The destination must not be an existing Slack thread.
- The destination uses a Slack channel id; it must not use or accept a user id.
- The dispatch input is plain text.
- Metadata is for correlation only and must not affect authorization.
- Dispatch input is inserted as user-role synthetic conversation content.
- The core-owned system actor controls execution identity, audit, and auth policy; it does not make `input` privileged system or developer instructions.
- System dispatches have no requester, no user OAuth token access, and no interactive auth continuation.
- Schedule-management tools are unavailable during system dispatches.
- App or bot credential tools may run only when their existing policy allows system actor use.

### Internal Agent Invocation

`agent.dispatch` persists a core-owned dispatch record, then fires a signed internal serverless callback. The callback is the execution unit.

Core exposes one internal dispatch callback endpoint:

```txt
POST /api/internal/agent-dispatch
```

The endpoint is core-owned. Plugins must not register dispatch routes, choose dispatch callback URLs, or receive the raw callback `Request`.

Core should use the same state/serverless paradigm as existing turn continuation:

1. Persist dispatch metadata and expected version in durable state.
2. Sign an internal callback using the core internal secret.
3. POST the callback to a core-owned internal endpoint.
4. The endpoint verifies the signature and timestamp.
5. The endpoint loads the durable dispatch record.
6. The endpoint transitions the dispatch under the dispatch lock before running it.
7. The endpoint runs the dispatched agent request and persists the result.

The callback body should contain only a small core envelope, such as dispatch id and expected version. The prompt, destination, actor, and metadata live in durable state.

Heartbeat auth and dispatch callback auth are separate:

- `/api/internal/heartbeat` uses bearer cron auth, using `JUNIOR_SCHEDULER_SECRET` or `CRON_SECRET`.
- Dispatch callbacks use HMAC body signing with timestamp skew checks and `JUNIOR_SECRET`, matching the existing timeout-resume callback model.

### Dispatch State

Core dispatch state is separate from plugin state. The scheduler plugin records that a run was dispatched; core records whether the dispatched agent request actually ran and delivered output.

Plugin state is namespaced by core using collision-resistant internal keys.
Plugin-visible keys must be non-empty and bounded. Plugins do not receive raw
Redis keys, raw state adapter handles, or another plugin's namespace.

Minimal dispatch record:

```ts
type DispatchRecord = {
  id: string;
  plugin: string;
  idempotencyKey: string;
  status:
    | "pending"
    | "running"
    | "awaiting_resume"
    | "completed"
    | "failed"
    | "blocked";
  version: number;
  actor: {
    type: "system";
    id: string;
  };
  destination: {
    platform: "slack";
    teamId: string;
    channelId: string;
  };
  input: string;
  metadata?: Record<string, string>;
  createdAtMs: number;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAtMs?: number;
  resumeCheckpointVersion?: number;
  lastCallbackAtMs?: number;
  updatedAtMs: number;
  resultMessageTs?: string;
  errorMessage?: string;
};
```

Plugin-visible `Dispatch` is a projection of this record, not the full stored value.

The dispatch id should be deterministic from plugin name and idempotency key. Duplicate `dispatch(...)` calls return the existing dispatch id and may re-fire the internal callback only when the existing record is incomplete.

`ctx.agent.get(id)` returns only dispatches owned by the calling trusted plugin. It does not expose prompt text, destination details, actor details, metadata, conversation state, tool calls, model messages, logs, or credentials.

Dispatch records use `THREAD_STATE_TTL_MS`, the same retention window as thread/checkpoint state. `ctx.agent.get(id)` is a short-to-medium-term reconciliation API, not permanent run history. After the retention window expires, `ctx.agent.get(id)` returns `undefined`.

The scheduler plugin owns durable task and run history in its namespaced state. When it observes a terminal dispatch through `ctx.agent.get(id)`, it copies the terminal status, result timestamp, and error summary onto the scheduler run record. The scheduler must not depend on core dispatch records remaining readable forever.

### Dispatch Recovery

Core owns recovery for incomplete dispatches. Plugins do not need to understand callback delivery or platform lifetime failures.

The heartbeat endpoint performs two bounded phases:

1. Re-drive stale core dispatches within a bounded core recovery budget.
2. Invoke trusted plugin `heartbeat(ctx)` handlers within a separate bounded plugin budget.

Core recovery must not starve when plugin heartbeat handlers are slow or failing. Plugin heartbeat work must not starve because core recovery found a large backlog; unfinished recovery remains durable for a later heartbeat.

Core may re-fire a signed dispatch callback when a dispatch is incomplete and stale:

- `pending` with no recent callback attempt
- `running` with an expired lease
- `awaiting_resume` with an expired lease or missing callback attempt

Core must not re-fire terminal dispatches:

- `completed`
- `failed`
- `blocked`

Recovery is bounded by attempt count, max dispatch age, max continuation slices, and the dispatch retention window. A dispatch that exceeds retry bounds is marked `failed`. A dispatch that ages out of retained core state is no longer recoverable by core.

### Serverless Slice Model

Each dispatch callback owns one bounded execution slice.

Callback route behavior:

1. Verify HMAC signature and timestamp.
2. Parse the small callback envelope.
3. Register the dispatch work with platform `waitUntil`.
4. Return `202 Accepted`.

Slice behavior:

1. Load and claim the dispatch.
2. Run one generation and delivery attempt.
3. If the agent times out at a resumable boundary, persist the checkpoint, mark the dispatch `awaiting_resume`, and schedule another signed dispatch callback.
4. If the dispatch reaches the slice cap, mark it `failed`.

The route must not rely on process memory, timers, or a long-lived worker after the platform request lifetime ends. The only in-process lifetime extension is the platform `waitUntil` task for the current callback.

### Locking And State Transitions

Dispatch mutation uses locks available from the existing state adapter. The implementation must not require a general compare-and-set primitive.

Lock classes:

- `dispatch:<id>` protects dispatch status, version, attempts, and leases.
- destination conversation lock protects conversation, artifact, sandbox, and delivery state.

Lock order is always:

1. dispatch lock
2. destination conversation lock

Code must not acquire those locks in the reverse order. Stale recovery uses durable status, version, attempt, and lease fields rather than process memory.

Dispatch leases are not renewed during a slice in V1. The lease duration must exceed the maximum callback slice budget plus platform scheduling slack. A retry may claim an expired lease only after verifying the dispatch is still non-terminal.

### Dispatched Agent Runner

The internal callback runs a core-owned dispatched agent runner. This runner is the durable execution boundary for `ctx.agent.dispatch`.

The runner owns:

- loading the dispatch record
- acquiring the destination conversation lock
- loading persisted conversation, artifact, sandbox, and channel configuration state
- creating or reusing the synthetic system-authored conversation message for the dispatch
- building conversation context
- calling `generateAssistantReply`
- delivering the reply to the destination
- committing conversation, artifact, sandbox, and dispatch state
- marking auth-required runs as blocked
- scheduling continuation when the agent times out at a resumable boundary

Plugins never see this runner or its dependencies.

The runner should generalize the current scheduled Slack runner behavior instead of exposing that runner as plugin API. It should keep the same delivery success rule: a dispatch is not complete until the visible destination post has been accepted and completion state has been persisted.

### Delivery Idempotency

Dispatch callbacks are at-least-once. Visible delivery should be best-effort exactly once.

The runner must use stable synthetic message ids:

- `dispatch:${dispatch.id}:user`
- `dispatch:${dispatch.id}:assistant`

Before posting, the runner checks persisted conversation state for the assistant message id. If it already has `meta.replied === true` and `meta.slackTs`, the runner marks the dispatch `completed` with that Slack timestamp and does not post again.

Slack post and state commit are not atomic. If Slack accepts the post but persisting completion state fails, the dispatch is marked failed when possible with a delivery-commit error. A retry must check persisted conversation state before posting again, but the system only guarantees best-effort duplicate suppression for this post-then-commit failure window.

### Dispatch Continuation

Dispatched agent requests must not use the existing Slack turn-resume route directly. The current turn-resume path reconstructs an interactive Slack thread turn and requires a persisted user-authored message. System dispatches have no requester and target a DM or channel, not an existing thread.

Timeout continuation for dispatched requests uses the dispatch callback path:

1. `generateAssistantReply` persists a resumable turn checkpoint for the dispatch conversation and turn id.
2. The runner catches `turn_timeout_resume`.
3. The runner marks the dispatch `awaiting_resume` with the next checkpoint version.
4. The runner signs and posts another dispatch callback for the same dispatch id.
5. The next callback verifies the dispatch is still `awaiting_resume` at the expected version.
6. The runner resumes `generateAssistantReply` with the same dispatch input, conversation id, turn id, actor, destination, and persisted Pi messages.
7. The final callback delivers once, commits final state, and marks the dispatch `completed`, `failed`, or `blocked`.

This keeps scheduled invocations aligned with the existing serverless execution model without treating them as interactive Slack turns.

Dispatch continuation invariants:

1. A dispatch has one stable conversation id and one stable turn id.
2. The turn id is derived from the dispatch id.
3. Duplicate callbacks must not run the same dispatch concurrently.
4. Duplicate callbacks must not deliver the same assistant output twice.
5. Timeout continuation must preserve cumulative usage and duration through the existing turn checkpoint state.
6. Auth continuation is disabled for system actors; auth-required outcomes become blocked results.

### Dispatch Limits

Core enforces reliability limits even for trusted plugin code:

- maximum dispatch calls per heartbeat context
- maximum dispatch input length
- maximum metadata keys and bytes
- maximum concurrent dispatches per destination
- maximum retry attempts
- maximum dispatch age
- maximum continuation slices

### Scheduler Plugin Flow

The scheduler plugin uses two trusted hooks:

1. `tools(ctx)` for interactive schedule management.
2. `heartbeat(ctx)` for due-run discovery and dispatch.

Heartbeat flow:

1. Load due tasks from the scheduler plugin's namespaced state.
2. Reconcile previously dispatched runs with `ctx.agent.get(dispatchId)`.
3. Claim up to a small limit of due runs.
4. Mark each claimed run as pending dispatch.
5. Call `ctx.agent.dispatch(...)` once per claimed run.
6. Store the returned dispatch id on the run record.
7. Leave remaining due work for a future heartbeat.

The scheduler heartbeat must not execute scheduled tasks inline. It only claims and dispatches bounded work.

If `ctx.agent.get(dispatchId)` returns `undefined` for a non-terminal scheduler run, the scheduler treats the core dispatch record as expired or missing. The scheduler may mark the run failed with an expiration error, or reclaim and redispatch only when its own run policy says that is safe. The scheduler must eventually transition the run to a terminal state or create a new redispatch attempt; it must not leave the original run non-terminal forever after core dispatch state expires.

Dispatch call for a scheduled run:

```ts
await ctx.agent.dispatch({
  idempotencyKey: run.id,
  destination: task.destination,
  input: buildScheduledTaskRunPrompt({ task, run, nowMs }),
  metadata: {
    taskId: task.id,
    runId: run.id,
  },
});
```

### Scheduler Run State

The scheduler plugin should make dispatch state explicit enough to recover from partial failures:

- due task
- claimed run
- pending dispatch
- dispatched
- running
- completed
- failed
- blocked
- skipped

Required invariants:

1. Heartbeat claims a due run before dispatch.
2. Dispatch success records the core dispatch id.
3. Duplicate dispatch attempts use the same idempotency key.
4. Duplicate internal callbacks do not execute the same run twice.
5. Stale pending-dispatch records are reclaimable by a later heartbeat.
6. Stale running records are reclaimable according to scheduler policy.
7. Scheduler tools derive destination from the active conversation context.
8. Users cannot create scheduled DMs for other users.
9. Existing Slack threads are never stored as task destinations.

### Core Capability Boundaries

Core must not expose these to plugins:

- raw Slack tokens
- Slack Web API clients
- raw HTTP requests for internal routes
- route registration
- Vercel config mutation
- raw Redis clients
- unrestricted state adapter access
- unrestricted agent runtime functions
- user OAuth tokens for system actor dispatches

Core may expose narrow capabilities:

- namespaced state
- plugin logger
- active turn context for tool registration
- `agent.dispatch`
- `agent.get`

## Failure Model

### Heartbeat Missed Or Late

No correctness failure. The next heartbeat can claim still-due work from durable state.

### Duplicate Heartbeat

Plugin state claiming and `agent.dispatch` idempotency suppress duplicate execution.

### Heartbeat Budget Exhausted

Core stops invoking additional handlers or the current handler times out. Plugins must leave unfinished work in durable state for a later heartbeat.

### Dispatch Call Fails

The plugin keeps the run in pending-dispatch or claimed state without a dispatch id. A later heartbeat may reclaim and retry dispatch after a stale timeout.

### Dispatch Succeeds But Callback Does Not Complete

The core dispatch record remains durable. A later heartbeat or future continuation mechanism may observe the incomplete dispatch and decide whether to retry according to core dispatch policy.

### Dispatch Blocks For Auth

System actor dispatches must not start interactive auth. Core returns or persists a blocked result. The scheduler plugin marks the scheduled run blocked and privately notifies the creator when possible through core-owned delivery behavior.

### Plugin Throws

Core logs the plugin heartbeat/tool error with plugin name and safe metadata. One plugin failure must not expose secrets or raw payloads, and must not grant that plugin broader capabilities.

## Observability

Core heartbeat logs should include:

- heartbeat invocation id
- trusted plugin name
- handler kind
- duration
- outcome
- dispatch count, when reported
- error class/message, when safe

Agent dispatch logs should include:

- dispatch id
- plugin name
- idempotency key
- actor type and id
- destination platform and conversation id
- plugin metadata keys safe for logs
- outcome

Dispatch recovery logs should include:

- stale dispatch re-driven by heartbeat
- dispatch retry bound exceeded
- dispatch expired before completion
- `ctx.agent.get(id)` miss for missing or expired dispatch state

Logs and spans must not include OAuth tokens, provider credentials, raw authorization URLs, Slack tokens, or private tool payloads.

## Verification

Use integration tests for:

- heartbeat endpoint authentication
- trusted plugin heartbeat invocation
- heartbeat best-effort isolation when one plugin fails
- namespaced state access
- `agent.dispatch` idempotency
- `agent.get` returns the caller plugin's dispatch projection
- `agent.get` does not return another plugin's dispatch
- `agent.get` returns `undefined` after dispatch retention expiry
- `agent.get` omits prompt, destination, actor, metadata, conversation state, tool calls, model messages, logs, and credentials
- internal callback signature verification
- scheduler heartbeat claims due runs but does not execute inline
- scheduler heartbeat dispatches one request per claimed run
- duplicate heartbeat does not duplicate dispatch records
- stale pending-dispatch run is reclaimable
- stale core dispatch recovery is bounded separately from plugin heartbeat work
- expired or missing dispatch lookup forces scheduler terminal reconciliation or redispatch
- system actor dispatch does not use requester OAuth or interactive auth

Use unit tests for:

- scheduler due-run claim state transitions
- agent dispatch input validation
- plugin name/id validation
- internal callback signing and parsing

Use evals for:

- interactive schedule creation behavior
- confirmation-first schedule authoring
- scheduled-run prompt execution behavior

## Related Specs

- `./plugin-spec.md`
- `./scheduler-spec.md`
- `./agent-session-resumability-spec.md`
- `./chat-architecture-spec.md`
- `./slack-agent-delivery-spec.md`
