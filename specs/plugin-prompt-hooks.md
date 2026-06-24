# Plugin Prompt Hooks And Tasks Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-22

## Purpose

Define the generic plugin hooks and background tasks that let runtime hook
plugins contribute prompt text and process completed agent-run sessions without
exposing raw Junior internals or creating memory-specific plugin APIs.

## Implementation Status

Plugin prompt hooks are implemented in Junior core and
`@sentry/junior-plugin-api`. The typed plugin task surface described here is
the target contract for background work. The previous post-run observation hook
shape is superseded by `session.completed` plugin tasks and should be removed
when the task runner lands.

## Scope

- Plugin-provided system prompt and user prompt contributions.
- Prompt hook context.
- Typed plugin background task registration.
- Completed agent-run session task contract for passive extraction workflows.
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

### Registration Surface

Runtime hook plugins may provide prompt hooks and typed background tasks:

```ts
interface PluginRegistrationInput {
  manifest: PluginManifest;
  hooks?: PluginHooks;
  tasks?: PluginTasks;
}

interface PluginHooks {
  systemPrompt?(
    ctx: SystemPromptContext,
  ): PromptMessage[] | Promise<PromptMessage[]>;

  userPrompt?(
    ctx: UserPromptContext,
  ): PromptMessage[] | undefined | Promise<PromptMessage[] | undefined>;
}

type PluginTasks = Record<string, PluginTaskDefinition<ZodTypeAny>>;
```

These hooks are app-code plugin hooks registered through
`defineJuniorPlugin({ manifest, hooks, tasks })`. Declarative `plugin.yaml`
manifests must not register prompt hooks or task handlers.

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
  db: object;
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
  db: object;
  destination: Destination;
  embedder: PluginEmbedder;
  log: PluginLogger;
  plugin: PluginMetadata;
  requester?: Requester;
  source: Source;
  state: PluginState;
  text: string;
}
```

`Source` is a runtime-normalized origin for the current request or completed
agent-run session. Slack sources use the same address fields as Slack
destinations plus source visibility and inbound message metadata:

```ts
type SourceType = "pub" | "priv";

type Source =
  | {
      platform: "slack";
      type: SourceType;
      teamId: string;
      channelId: string;
      messageTs?: string;
      threadTs?: string;
    }
  | {
      platform: "local";
      type: "priv";
      conversationId: string;
    };
```

Plugins should use the public source helpers from `@sentry/junior-plugin-api`
for common source decisions such as private-source checks and stable source key
derivation. Plugin implementations must not scatter Slack channel-prefix checks
or rebuild source keys from platform-specific fields.

The context must not expose:

- structured completion/model-review capabilities
- raw Slack clients or tokens
- raw HTTP requests
- raw Pi internals
- continuation, resume, retry, or lease state
- cross-plugin state
- model messages outside the safe hook-specific context

### Plugin Background Tasks

Plugin tasks let plugins perform durable post-run work without blocking visible
reply delivery. Core owns when tasks are scheduled, how they are queued, how
they are retried, and how task params are persisted.

```ts
interface PluginTaskDefinition<TSchema extends ZodTypeAny> {
  trigger?: PluginTaskTrigger;
  paramsSchema: TSchema;
  run(ctx: PluginTaskContext<z.output<TSchema>>): Promise<void> | void;
}

type PluginTaskTrigger = "session.completed";

interface PluginTaskContext<TParams> extends PluginContext {
  id: string;
  name: string;
  params: TParams;
  embedder: PluginEmbedder;
  model: PluginModel;
  state: PluginState;
  session: PluginSessionReader;
}

interface PluginSessionReader {
  load(): Promise<PluginSessionContext | undefined>;
}

interface PluginSessionContext {
  completedAtMs: number;
  conversationId: string;
  destination: Destination;
  messages: PluginSessionMessage[];
  requester?: Requester;
  sessionId: string;
  source: Source;
  successfulToolCalls: string[];
}

interface PluginSessionMessage {
  createdAtMs?: number;
  role: "user" | "assistant";
  text: string;
}

function definePluginTask<TSchema extends ZodTypeAny>(
  task: PluginTaskDefinition<TSchema>,
): PluginTaskDefinition<TSchema>;
```

Task params are schema-validated before persistence and again before execution.
They must contain stable references such as `conversationId`, `sessionId`, or
run/session ids. They must not contain raw conversation text, raw assistant
text, raw tool payloads, credentials, authorization URLs, OAuth tokens, Slack
tokens, or provider credentials.

The queue payload is a core-owned delivery envelope containing only a durable
task id. The durable task record carries plugin name, task name, parsed params,
status, attempt count, lease state, and timestamps. Plugins never receive raw
queue clients, queue topics, callback routes, message metadata, or delivery
acknowledgement controls.

`session.load()` returns a bounded core-owned projection reconstructed from the
completed session record and transcript/session-log storage. It must not expose
raw Pi internals, full transcript history, private tool arguments/results, or
provider credentials. Core applies source privacy rules before returning raw
message text to a plugin task. Unknown or private source visibility fails
closed unless a future explicit privacy contract allows that task.

Task rules:

1. Task names are resolved only inside the owning plugin.
2. Task params are bounded JSON-serializable data parsed by the task's
   `paramsSchema`.
3. Task handlers run with plugin-scoped `ctx.db`, `ctx.state`, logger, host
   model access, host embedding access, and task-specific readers.
4. Task handlers must be idempotent because delivery is at least once.
5. Core owns queue acknowledgement, retry, redelivery, worker leases, callback
   signing, and provider-specific visibility timeouts.
6. Plugins must not depend on task execution happening in the same process or
   same request that completed the agent run.

### `session.completed` Tasks

Core schedules `session.completed` tasks after a successful user-visible agent
run has been delivered and the completed session record has been durably
committed. The task params should be the minimum stable references needed to
reload the completed run/session, such as:

```ts
const sessionCompletedParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();
```

If the historical session id is not the stable run identity for a path, core may
include a separate run/session record id. The params should not duplicate
`source`, `destination`, `requester`, messages, or tool-call data when those can
be loaded from completed runtime storage.

The task idempotency key is derived from plugin name, task name, trigger name,
and the completed session reference. Duplicate queue delivery or duplicate
scheduling of the same completed session must run the plugin task at most once
successfully.

### Memory Plugin V1 Usage

The memory plugin should use the generic hooks and task surface as follows:

1. `userPrompt(ctx)` retrieves memories visible to the current requester and
   source, then returns a concise memory block for the run's triggering prompt.
2. `tasks.processSession` handles the `session.completed` trigger, loads the
   completed session projection, runs the memory-owned structured extraction
   agent, and writes accepted facts idempotently.
3. `tools(ctx)` may expose explicit memory tools such as `createMemory`,
   `removeMemory`, `listMemories`, and `searchMemories`.

Memory retrieval must not depend on the model choosing a search tool for default
recall. `searchMemories` remains the explicit model-visible recall path for
targeted recall and follow-up memory management. Other tools are for explicit
user management.

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
2. Core wraps user prompt contributions inside the existing run-context/user
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
3. Plugin task failure: log safe metadata, retry according to the core task
   policy, and do not change the completed visible run result.

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
- plugin task params are schema-validated before persistence and execution
- `session.completed` plugin tasks load bounded completed-session projections
  without exposing raw private payloads
- duplicate scheduling or queue delivery does not run a completed plugin task
  more than once successfully

Use unit tests for:

- hook return-shape validation
- task schema validation and plugin-local task name validation
- deterministic plugin ordering
- memory tool schema rejection of model-supplied actor or destination fields

Use evals for:

- automatic memory recall without explicit search tool use when automatic memory
  plugin is enabled
- explicit targeted memory recall through `searchMemories`
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
