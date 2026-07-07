# Plugin Background Tasks Spec

## Metadata

- Created: 2026-06-24
- Last Edited: 2026-06-24

## Purpose

Define the durable background task contract for plugins.

Plugin tasks exist so plugins can perform bounded post-run work, such as
memory extraction, without blocking user-visible reply delivery or depending on
an in-process background worker surviving a serverless request.

## Scope

- App-code plugin task registration through `defineJuniorPlugin(...)`.
- The public task definition and task context exposed by
  `@sentry/junior-plugin-api`.
- Core-owned queue payloads, Vercel Queue dispatch, retries, and callback
  routing.
- Completed-session scheduling and the completed-run projection.
- Local development execution for plugin tasks.
- Verification requirements for task scheduling, execution, and idempotency.

## Non-Goals

- A generic workflow engine.
- Plugin-declared tasks in `plugin.yaml`.
- Model-visible task controls or task scheduling tools.
- Exposing Vercel Queue clients, topics, callbacks, or acknowledgement controls
  to plugins.
- Queueing every model call, tool call, or agent step.
- Replacing durable conversation execution; see `./task-execution.md`.
- Exactly-once delivery from the queue provider.
- Storing raw conversation transcripts, raw tool payloads, credentials, or
  provider secrets in task params or queue payloads.

## Contracts

### Registration Surface

Trusted app-code plugins may register typed tasks:

```ts
interface PluginRegistrationInput {
  manifest: PluginManifest;
  tasks?: PluginTasks;
}

type PluginTasks = Record<string, PluginTaskDefinition>;

interface PluginTaskDefinition {
  run(ctx: PluginTaskContext): Promise<void> | void;
}
```

Rules:

1. Task handlers are registered only from app-code plugin definitions.
   Declarative plugin manifests must not register executable task handlers.
2. Task names are scoped to the owning plugin and must be stable camel-case
   identifiers.
3. The public task definition does not expose scheduling controls. Core decides
   when to enqueue registered tasks; V1 includes completed-session scheduling as
   the first scheduling point with a real implementation need.
4. A task handler must be idempotent. Queue delivery is at least once and
   callback invocations may be duplicated.

### Task Params

Task params carry stable references only. For a completed agent-run session,
the canonical params shape is:

```ts
const pluginTaskParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

type PluginTaskParams = z.output<typeof pluginTaskParamsSchema>;
```

Task params must not include:

- raw user text
- raw assistant text
- full transcript history
- raw Pi messages
- raw tool arguments or tool results
- provider credentials
- authorization URLs
- OAuth tokens
- Slack tokens
- private keys, passwords, or connection strings with credentials

If a task needs runtime context, it must load a bounded projection through a
core-owned reader on the task context.

### Task Context

Task handlers receive a narrow plugin task context:

```ts
interface PluginTaskContext extends PluginContext {
  embedder: PluginEmbedder;
  id: string;
  model: PluginModel;
  name: string;
  state: PluginState;
  run: {
    load(): Promise<PluginRunContext>;
  };
}
```

`ctx.db`, `ctx.state`, `ctx.model`, and `ctx.embedder` are direct host
capabilities. Core must not add extra database facades or schema-hiding layers
solely to restrict plugins.

The task context must not expose raw queue messages, queue clients, queue
topics, route URLs, retry acknowledgement controls, raw HTTP requests, provider
credentials, raw Slack clients, or cross-plugin state.

### Queue Payload

The queue payload is a core-owned bounded task request:

```ts
interface PluginTaskQueueMessage {
  plugin: string;
  name: string;
  params: PluginTaskParams;
}
```

Core owns parsing, routing, queue topic selection, and callback registration.
Queue messages must not include raw transcript text, raw tool payloads,
credentials, tokens, or unbounded run data.

The task id is derived from the plugin name, task name, and parsed params. When
sending to Vercel Queues, core must use that id as the queue `idempotencyKey` so
duplicate wakeups for the same logical task collapse at the provider layer when
Vercel can dedupe them. Plugin task handlers still must be idempotent because
Vercel Queues are at least once.

### Execution

Core executes a task by:

1. Parsing the queue payload when invoked through the queue callback.
2. Resolving the current plugin task registration.
3. Re-parsing task params with the core task params schema.
4. Building the task context.
5. Calling the task handler.
6. Letting thrown handler errors propagate to Vercel Queues for retry.

Task execution may happen in a different process and request than the agent run
that scheduled it. Plugins must not depend on in-memory state from the original
request.

### Completed-Session Scheduling

Core schedules completed-session tasks after:

1. The agent run reached a successful completed state.
2. The user-visible final response was delivered.
3. The completed session record is durable enough for task execution to reload
   it.

Completed-session task scheduling is best effort relative to visible delivery.
If scheduling fails, Junior must log safe metadata and keep the visible run
successful.

For local CLI development, core may process scheduled tasks inline after
visible delivery, but the inline path must still use the same task message and
task runner used by queued execution.

### Completed Run Projection

`ctx.run.load()` returns a bounded core-owned projection of the completed agent
run. The queue params still use `sessionId` because that is the historical
persisted session-record key.

```ts
interface PluginRunContext {
  completedAtMs: number;
  conversationId: string;
  destination: Destination;
  actor: Actor;
  runId: string;
  source: Source;
  transcript: PluginRunTranscriptEntry[];
}

type PluginRunTranscriptEntry =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | {
      type: "toolResult";
      toolName: string;
      isError: boolean;
      text?: string;
    };
```

The projection may include normalized user-authored text, assistant reply text,
tool-result text, source, destination, and actor. It must not expose raw Pi
internals, raw tool arguments, full unbounded transcript history, provider
credentials, OAuth tokens, Slack tokens, or private binary payloads.

If the session record is unavailable, incomplete, missing source/destination,
or not completed, `run.load()` throws so the task follows the normal retry
and terminal failure policy.

Source privacy is evaluated by the plugin using the normalized `Source` helpers
from `@sentry/junior-plugin-api`. Plugins must not scatter platform-specific
source visibility logic.

## Failure Model

1. Invalid registration: app startup validation fails before partial plugin
   registration.
2. Invalid task params at scheduling time: scheduling fails before queue
   dispatch.
3. Invalid queue payload or params at callback time: reject the
   callback without running plugin code or retrying.
4. Missing task registration at execution time: the task attempt fails and
   follows Vercel Queue retry policy.
5. Malformed queue callback payload: reject the callback without running a task.
6. Duplicate queue delivery: handler idempotency and downstream storage
   uniqueness make duplicate delivery safe; core also serializes concurrent
   attempts for the same task id with a durable lock.
7. Handler failure: let the error propagate so Vercel Queues can retry the
   message according to queue policy.
8. Exhausted queue retries: acknowledge the poison message and do not change
   the completed visible run result.
9. Local inline task failure: log safe metadata and keep the already delivered
   visible reply successful.

## Observability

Plugin task logs and spans may include:

- plugin name
- task name
- task id
- safe error message
- duration

Plugin task logs and spans must not include raw private prompt text, raw
conversation text, raw tool arguments, raw tool results, provider credentials,
tokens, authorization URLs, or cross-plugin state.

## Verification

Use component or integration tests for:

- params parsed before queue dispatch and again before execution
- `session.completed` scheduling sends one queue message per plugin task
- duplicate scheduling derives the same idempotency id
- task execution loads a bounded completed-run projection from durable
  session storage
- failed task attempts bubble to the queue retry boundary
- queue callback parsing rejects malformed payloads
- local CLI task processing uses the same task runner path

Use unit tests for:

- startup-local task name validation
- task id derivation from parsed params
- queue payload parsing when kept as local deterministic logic

Use evals only for model-dependent behavior performed by a plugin task, such as
memory extraction quality. Do not use evals to prove deterministic task storage,
queue payload parsing, or retry mechanics.

## Related Specs

- `./plugin-runtime.md`
- `./plugin-prompt-hooks.md`
- `./plugin-database.md`
- `./task-execution.md`
- `./agent-session-resumability.md`
- `./memory-plugin/index.md`
- `./memory-plugin/extraction.md`
- `../policies/serverless-background-work.md`
