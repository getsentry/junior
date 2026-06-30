# Plugin Prompt Hooks Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-24

## Purpose

Define the generic plugin hooks that let runtime hook plugins contribute prompt
text without exposing raw Junior internals or creating memory-specific plugin
APIs.

## Implementation Status

Plugin prompt hooks are implemented in Junior core and
`@sentry/junior-plugin-api`. The previous post-run observation hook shape is
superseded by the task surface defined in `./plugin-tasks.md`.

## Scope

- Plugin-provided system prompt and user prompt contributions.
- Prompt hook context.
- Security and rendering boundaries for prompt contributions.
- V1 memory plugin usage of these generic hooks.

## Non-Goals

- A memory-specific retrieval or extraction hook.
- Plugin-owned prompt rendering.
- A general event bus for every runtime lifecycle transition.
- Model-visible memory management as the only memory path.
- Storage schema for long-lived memory records.
- Plugin background task execution; see `./plugin-tasks.md`.

## Contracts

### Registration Surface

Runtime hook plugins may provide prompt hooks:

```ts
interface PluginRegistrationInput {
  manifest: PluginManifest;
  hooks?: PluginHooks;
}

interface PluginHooks {
  systemPrompt?(
    ctx: SystemPromptContext,
  ): PromptMessage[] | Promise<PromptMessage[]>;

  userPrompt?(
    ctx: UserPromptContext,
  ): PromptMessage[] | undefined | Promise<PromptMessage[] | undefined>;
}
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
  db: unknown;
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
  db: unknown;
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

### Memory Plugin V1 Usage

The memory plugin should use the generic prompt hook surface as follows:

1. `userPrompt(ctx)` retrieves memories visible to the current requester and
   source, then returns a concise memory block for the run's triggering prompt.
2. `tools(ctx)` may expose explicit local memory tools such as `createMemory`,
   `removeMemory`, `listMemories`, and `searchMemories`; the host exposes them
   to the model as `memory_createMemory`, `memory_removeMemory`,
   `memory_listMemories`, and `memory_searchMemories`.

Passive memory learning uses the task surface defined in `./plugin-tasks.md`.
Memory retrieval must not depend on the model choosing a search tool for default
recall. `memory_searchMemories` remains the explicit model-visible recall path
for targeted recall and follow-up memory management. Other tools are for
explicit user management.

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
  plugin is enabled
- explicit targeted memory recall through `memory_searchMemories`
- explicit create/list/remove memory workflows
- secret rejection in explicit and passive memory paths

## Related Specs

- `./agent-prompt.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-tasks.md`
- `./memory-plugin/index.md`
- `./plugin-heartbeat.md`
- `./identity.md`
- `./data-redaction-policy.md`
- `./harness-tool-context.md`
