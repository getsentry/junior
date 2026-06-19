# Plugin Prompt Hooks Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-19

## Purpose

Define the generic plugin hooks that let runtime hook plugins contribute prompt
text, observe completed turns, and enqueue plugin background work without
exposing raw Junior internals or creating memory-specific plugin APIs.

## Implementation Status

Plugin prompt hooks are implemented in Junior core and
`@sentry/junior-plugin-api`. Turn observation hooks and background task handlers
remain target design for a later implementation slice.

## Scope

- Plugin-provided system prompt and user prompt contributions.
- Prompt hook context.
- Post-turn observation hook and plugin background task contract for passive
  extraction workflows.
- Security and rendering boundaries for prompt contributions.
- V1 memory plugin usage of these generic hooks.

## Non-Goals

- A memory-specific retrieval or extraction hook.
- Plugin-owned prompt rendering.
- A general event bus for every runtime lifecycle transition.
- Model-visible memory management as the only memory path.
- Storage schema for long-lived memory records.
- Exposing raw queue clients, queue topic names, callback routes, or worker
  implementation details to plugins.

## Contracts

### Hook Surface

Runtime hook plugins may provide prompt and observation hooks:

```ts
interface PluginHooks {
  systemPrompt?(
    ctx: SystemPromptContext,
  ): PromptMessage[] | Promise<PromptMessage[]>;

  userPrompt?(
    ctx: UserPromptContext,
  ): PromptMessage[] | undefined | Promise<PromptMessage[] | undefined>;

  observeTurn?(ctx: TurnObservationContext): void | Promise<void>;

  tasks?: Record<string, PluginTaskHandler>;
}
```

These hooks are app-code plugin hooks registered through
`defineJuniorPlugin({ manifest, hooks })`. Declarative `plugin.yaml` manifests
must not register prompt or observation hooks.

### Prompt Messages

Prompt messages are intentionally small:

```ts
interface PromptMessage {
  text: string;
}
```

Rules:

1. `text` is plugin-provided prompt text after the plugin has applied its own
   domain policy.
2. Core owns ordering between plugins, wrapper rendering, escaping where needed,
   total size limits, and failure behavior.
3. Messages are not durable plugin state by themselves. Plugins that need
   durable continuity must use their own plugin storage.
4. Core may assign internal IDs for rendering, logging, and diagnostics; those
   IDs are not part of the plugin public contract.

### System Prompt Hook

`systemPrompt(ctx)` contributes stable plugin-level prompt text.

```ts
interface SystemPromptContext {
  log: PluginLogger;
  platform: Platform;
  plugin: PluginMetadata;
}
```

System prompt contributions:

1. Must not include requester-specific, conversation-specific, or private data.
2. Must not include provider credentials, authorization URLs, tokens, or raw
   tool payloads.
3. Must be byte-stable for the same installed plugin configuration and source
   platform.
4. Should be used sparingly for plugin behavior rules that cannot live in tool
   descriptions, schemas, skills, or user prompt context.

Core appends accepted system prompt contributions to the platform static prompt
after core-owned behavior rules and before the model receives the first user
message. Plugin system prompt text remains subordinate to core safety,
credential, tool, and output rules.

### User Prompt Hook

`userPrompt(ctx)` contributes dynamic request-scoped prompt text. Core invokes
the hook once while constructing the fresh triggering user prompt of an agent
run. Steering messages delivered while that run is already active do not invoke
`userPrompt`.

Rules:

1. User prompt contributions may depend on the current requester, source,
   destination, conversation id, user text, and plugin state.
2. User prompt contributions must be inserted into the model-visible user
   message, not the static system prompt.
3. The hook must not receive runtime implementation details such as timeout
   continuation or auth-resume state. It receives product-level prompt facts
   only.
4. If the hook has no prompt messages, it may return `undefined` or an empty
   array.
5. Resume records that already contain a prompt checkpoint continue from stored
   Pi history and must not invoke `userPrompt` again. Resume records captured
   before a prompt checkpoint rebuild the fresh prompt and invoke `userPrompt`
   once.

### User Prompt Context

`UserPromptContext` exposes only narrow runtime facts and helper surfaces:

```ts
interface UserPromptContext {
  conversationId?: string;
  destination?: Destination;
  log: PluginLogger;
  plugin: PluginMetadata;
  requester?: Requester;
  source: Source;
  state: PluginState;
  text: string;
}
```

The context must not expose:

- raw Slack clients or tokens
- raw HTTP requests
- raw Pi internals
- continuation, resume, retry, or lease state
- cross-plugin state
- model messages outside the safe hook-specific context

### Turn Observation Hook

`observeTurn(ctx)` lets plugins inspect a completed turn and enqueue bounded
post-turn work such as passive memory extraction.

Core invokes observation hooks only after final turn state is committed far
enough that the hook cannot affect whether the user-visible turn succeeds.

Observation context should include:

- requester, source, destination, and conversation id
- bounded user-visible turn text needed by the plugin
- safe metadata about attachments and tool use
- plugin-scoped durable state and logger
- plugin-scoped background task enqueue capability

The bounded observation payload is a runtime-owned projection, not a raw
transcript. Core may expose the same projection directly to `observeTurn(ctx)`
and later through `PluginTaskContext.observation.load()` for
observation-backed tasks.

Observation hooks must not receive provider credentials, raw authorization URLs,
raw Slack clients, or unrestricted transcript history. For private
conversations, observation payloads must follow the same raw-payload restrictions
as runtime code: a plugin may receive private turn text only when it is an
explicitly enabled trusted host plugin whose contract requires that payload.

Observation hooks must be best effort. A thrown observation error must be logged
with safe metadata and must not fail the already-completed user turn.

### Plugin Background Tasks

Observation hooks may enqueue plugin-owned background tasks through a
core-owned task capability:

```ts
interface PluginTaskEnqueueOptions {
  idempotencyKey: string;
  name: string;
  payload?: unknown;
}

interface PluginTaskEnqueueResult {
  id: string;
  status: "created" | "already_exists";
}

interface PluginTaskQueue {
  enqueue(options: PluginTaskEnqueueOptions): Promise<PluginTaskEnqueueResult>;
}

interface PluginTaskContext extends PluginContext {
  id: string;
  name: string;
  payload?: unknown;
  observation?: {
    load(): Promise<TurnObservationPayload | undefined>;
  };
}

type PluginTaskHandler = (ctx: PluginTaskContext) => Promise<void> | void;
```

The exact host implementation is not part of the plugin API. Core may run
plugin tasks with the existing queue infrastructure, a signed internal callback,
a future dedicated task worker, or a local in-process test worker. Plugin code
must observe the same contract in all cases.

Task rules:

1. Task names are resolved only inside the owning plugin.
2. Idempotency is scoped to plugin name and task name.
3. Task payloads must be bounded JSON-serializable data.
4. Task payloads should contain stable references and safe metadata, not raw
   private prompt text, raw tool payloads, credentials, or tokens.
5. Task handlers run with plugin-scoped `ctx.db`, `ctx.state`, logger, and the
   runtime-owned context needed by that task type.
6. Observation-backed tasks receive an `observation.load()` helper when core can
   reconstruct a bounded observation payload from durable runtime state.
7. Task handlers must be idempotent because delivery is at least once.
8. Core owns queue acknowledgement, retry, redelivery, worker leases, callback
   signing, and provider-specific visibility timeouts.
9. Plugins must not depend on task execution happening in the same process or
   same request as `observeTurn`.

For memory extraction, the observation hook should enqueue a task with stable
conversation/session/message references. The task worker reloads the bounded
observation payload from durable runtime state before invoking the plugin task
handler. Queue payloads must not become the authority for private conversation
text.

### Memory Plugin V1 Usage

The memory plugin should use the generic hooks as follows:

1. `userPrompt(ctx)` retrieves memories visible to the current requester and
   source, then returns a concise memory block for the run's triggering prompt.
2. `observeTurn(ctx)` enqueues an idempotent memory extraction task for the
   completed turn.
3. `tasks.extractMemories(ctx)` reloads the bounded observation payload,
   validates accepted facts, and writes memories idempotently.
4. `tools(ctx)` may expose explicit memory tools such as `createMemory`,
   `removeMemory`, `listMemories`, and `searchMemories`.

When automatic memory injection is enabled, retrieval must not depend on the
model choosing a search tool. When automatic memory injection is disabled by
install policy, `searchMemories` is the explicit model-visible recall path.
Other tools are for explicit user management.

### Memory Tool Constraints

V1 memory tools are context-bound:

1. Tool schemas must not expose model-supplied Slack team ids, channel ids,
   user ids, or arbitrary visibility overrides.
2. Creation scope derives from runtime-owned requester, source, and
   destination context.
3. Listing and removal must show or affect only memories visible in the current
   context.
4. Tools must reject secrets, credentials, tokens, authorization URLs, and
   private keys even when the user explicitly asks to remember them.
5. Tool failures caused by invalid user/model input must be model-visible tool
   input errors.

### Rendering And Ordering

Core owns prompt rendering:

1. Core calls plugins in deterministic plugin-name order.
2. Core wraps user prompt contributions inside the existing turn-context/user
   prompt structure owned by `buildTurnContextPrompt(...)`.
3. Core applies per-contribution and total prompt extension size limits.
4. Core omits empty contributions.
5. Core records safe metadata about accepted contributions without exposing raw
   private prompt text through logs, traces, or dashboard APIs.
6. Core must fail closed when prompt contribution rendering, validation, or
   schema validation fails.

## Failure Model

1. Invalid hook return shape: skip that plugin contribution, log safe metadata,
   and continue unless startup validation can catch the problem earlier.
2. Oversized contribution: truncate only if the contribution contract supports
   deterministic truncation; otherwise omit and log safe metadata.
3. Observation hook failure: log safe metadata and do not change the completed
   turn result.

## Observability

Prompt hook logs and spans may include:

- plugin name
- hook name
- contribution count
- contribution ids
- contribution text character counts
- outcome and duration

Prompt hook logs and spans must not include raw private prompt text, private
conversation text, provider credentials, tokens, authorization URLs, raw tool
arguments, raw tool results, or cross-plugin state.

## Verification

Use integration tests for:

- plugin system prompt contributions appear in the static prompt without
  exposing requester-specific data
- plugin user prompt contributions appear in model-visible user prompt context
- user prompt hooks run once for the triggering user prompt of each agent run
- user prompt hooks do not run for steering messages delivered during an active
  run
- user prompt hooks do not run again when resuming from a stored prompt
  checkpoint
- user prompt hooks run when resuming a record captured before the prompt
  checkpoint
- private conversation prompt contribution payloads are redacted from logs,
  traces, and dashboard APIs

Use unit tests for:

- hook return-shape validation
- deterministic plugin ordering
- memory tool schema rejection of model-supplied actor or destination fields

Use evals for:

- automatic memory recall without explicit search tool use when automatic memory
  injection is enabled
- explicit memory recall through `searchMemories` when automatic memory
  injection is disabled
- explicit create/list/remove memory workflows
- secret rejection in explicit and passive memory paths

## Related Specs

- `./agent-prompt.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./task-execution.md`
- `./memory-plugin/index.md`
- `./plugin-heartbeat.md`
- `./identity.md`
- `./data-redaction-policy.md`
- `./harness-tool-context.md`
