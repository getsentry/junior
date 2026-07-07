# Plugin Heartbeat Spec

## Metadata

- Created: 2026-05-26
- Last Edited: 2026-06-06

## Purpose

Define the plugin heartbeat and tool-registration surface needed to move scheduler behavior out of Junior core without exposing raw routes, platform internals, Slack clients, or agent execution internals.

## Scope

- Plugin hook boundary.
- Plugin tool registration hook.
- Core-owned heartbeat endpoint.
- Heartbeat context and reliability semantics.
- Capability boundaries exposed to plugins.

## Non-Goals

- Manifest-only scheduler plugins.
- Plugin-defined routes or per-plugin heartbeat URLs.
- Plugin-owned Vercel/deployment adapter behavior.
- Generic durable queue infrastructure.
- Raw Slack Web API, raw agent runtime, raw Redis, or unrestricted state adapter access.
- Durable agent dispatch internals; see [Plugin Dispatch Spec](./plugin-dispatch.md).

## Trust Boundary

Heartbeat and agent dispatch are plugin hook capabilities. They are available
only to plugins explicitly enabled through the app's
`defineJuniorPlugins(...)` set.

Declarative `plugin.yaml` manifests must not register heartbeat handlers, internal routes, or agent dispatch behavior.

Core owns:

- route registration
- internal route authentication
- deployment cron configuration
- plugin lookup
- plugin state namespaces
- serverless continuation callbacks
- agent execution and Slack delivery
- auth mode enforcement
- logging and redaction

Plugins own only their domain logic: tools, heartbeat work discovery, durable plugin state records, and dispatch inputs.

## Interactive Tool Registration

Plugins may register turn-scoped tools:

```ts
interface PluginHooks {
  tools?(ctx: ToolRegistrationContext): Record<string, ToolDefinition>;
}
```

`ToolRegistrationContext` exposes only current turn context needed to decide whether tools are available:

- active source context
- default outbound destination, when present
- actor, when present
- `conversationId`: opaque Junior session identity (e.g. `slack:{channelId}:{threadTs}` for interactive turns)
- `source`: runtime-owned shared `Source`; Slack sources carry raw `teamId`, `channelId`, and optional thread/message timestamps
- `destination`: runtime-owned shared outbound `Destination`, when an outbound target is available
- namespaced plugin state
- current user text
- schedule-tool suppression for system dispatches

Tools returned by this hook participate in the normal tool pipeline: schema validation, tool guidance, tracing, and plugin `beforeToolExecute` hooks.

Returned tools must carry concise model-facing descriptions explaining what they do and when to use them. Plugin-domain policy belongs in the tool description, schema descriptions, `promptSnippet`, or `promptGuidelines`. Core prompt rules must stay plugin-agnostic and must not name scheduler tools or other specific plugin tools.

## Core Heartbeat Endpoint

Core exposes one internal heartbeat endpoint:

```txt
GET /api/internal/heartbeat
```

The endpoint is core-owned and deployment-owned. Plugins must not register heartbeat routes, choose heartbeat URLs, or receive the raw `Request`.

Core responsibilities:

1. Verify the request with the configured internal heartbeat secret.
2. Re-drive stale core dispatches within a bounded core recovery budget.
3. Enumerate plugin heartbeat handlers.
4. Invoke handlers with bounded `HeartbeatContext`.
5. Enforce per-handler and total plugin heartbeat budgets.
6. Log core recovery and per-plugin outcomes.
7. Return a generic response that does not expose installed plugin details unnecessarily.

The endpoint is a pulse, not a job runner.

## Heartbeat Hook

Plugins may implement:

```ts
interface PluginHooks {
  heartbeat?(ctx: HeartbeatContext): Promise<HeartbeatResult | void>;
}
```

Heartbeat semantics:

- serverless-triggered
- best effort
- may run late or be skipped
- may run concurrently with another heartbeat invocation
- may run more than once for the same wall-clock minute
- must be idempotent
- must process bounded work
- must persist progress in durable state
- must not rely on memory, timers, or process lifetime

Core does not guarantee every heartbeat handler runs on every pulse. Durable state and idempotent claiming are the reliability boundary.

## Heartbeat Context

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

Do not expose `waitUntil` to plugins. Core may use platform lifetime extension internally, but plugin handlers should be written as bounded request handlers.

## Core Capability Boundaries

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

- Missed or late heartbeat: no correctness failure; later heartbeat can claim still-due work.
- Duplicate heartbeat: plugin state claiming and dispatch idempotency suppress duplicate execution.
- Heartbeat budget exhausted: unfinished work remains in durable state for a later heartbeat.
- Plugin throws: core logs safe metadata and isolates the failure from other plugins.

Dispatch-specific failure handling is defined in [Plugin Dispatch Spec](./plugin-dispatch.md).

## Observability

Core heartbeat logs should include:

- heartbeat invocation id
- plugin name
- handler kind
- duration
- outcome
- dispatch count, when reported
- safe error class/message

Logs and spans must not include OAuth tokens, provider credentials, raw authorization URLs, Slack tokens, or private tool payloads.

## Verification

Use integration tests for:

- heartbeat endpoint authentication
- plugin heartbeat invocation
- heartbeat isolation when one plugin fails
- namespaced state access
- scheduler heartbeat claims due runs but does not execute inline
- duplicate heartbeat does not duplicate dispatch records

Use unit tests for:

- scheduler due-run claim transitions
- plugin name/id validation

Use evals for:

- interactive schedule creation behavior
- confirmation-first schedule authoring

## Related Specs

- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-dispatch.md`
- `./scheduler.md`
- `./agent-session-resumability.md`
