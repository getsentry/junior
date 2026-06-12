# Plugin Prompt Hooks Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-12

## Purpose

Define the generic plugin hooks that let runtime hook plugins contribute prompt
text, observe completed turns, and keep per-session append-only bookkeeping
without exposing raw Junior internals or creating memory-specific plugin APIs.

## Scope

- Plugin-provided system prompt and user prompt contributions.
- Prompt hook context and plugin-scoped session append state.
- Post-turn observation hook for passive extraction workflows.
- Security and rendering boundaries for prompt contributions.
- V1 memory plugin usage of these generic hooks.

## Non-Goals

- A memory-specific retrieval or extraction hook.
- Plugin-owned prompt rendering.
- Cross-plugin session state access.
- A general event bus for every runtime lifecycle transition.
- Model-visible memory management as the only memory path.
- Storage schema for long-lived memory records.

## Contracts

### Hook Surface

Runtime hook plugins may provide prompt and observation hooks:

```ts
interface AgentPluginHooks {
  systemPrompt?(
    ctx: SystemPromptHookContext,
  ): PromptContribution[] | Promise<PromptContribution[]>;

  userPrompt?(
    ctx: UserPromptHookContext,
  ): UserPromptContributionResult | Promise<UserPromptContributionResult>;

  observeTurn?(ctx: TurnObservationContext): void | Promise<void>;
}
```

These hooks are app-code plugin hooks registered through
`defineJuniorPlugin({ manifest, hooks })`. Declarative `plugin.yaml` manifests
must not register prompt or observation hooks.

### Prompt Contributions

Prompt contributions are intentionally small:

```ts
interface PromptContribution {
  id: string;
  text: string;
}
```

Rules:

1. `id` is unique only within one plugin hook invocation.
2. `text` is plugin-provided prompt text after the plugin has applied its own
   domain policy.
3. Core owns ordering between plugins, wrapper rendering, escaping where needed,
   total size limits, and failure behavior.
4. Contributions are not durable state by themselves. If a plugin needs
   deterministic continuity, it must use session append state.

### System Prompt Hook

`systemPrompt(ctx)` contributes stable plugin-level prompt text.

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
the hook for every model-visible user prompt.

```ts
interface UserPromptContributionResult {
  contributions?: PromptContribution[];
  sessionState?: PluginSessionStateAppend[];
}
```

Rules:

1. User prompt contributions may depend on the current requester, source,
   destination, conversation id, user text, plugin state, and plugin session
   append state.
2. User prompt contributions must be inserted into the model-visible user
   message, not the static system prompt.
3. The hook must not receive runtime implementation details such as timeout
   continuation or auth-resume state. It receives product-level prompt facts
   only.
4. Core commits returned `sessionState` appends only after it accepts the
   corresponding contribution result for rendering.
5. If the hook returns no contributions, core must not append its returned
   `sessionState`.

### User Prompt Context

`UserPromptHookContext` exposes only narrow runtime facts and helper surfaces:

```ts
interface UserPromptHookContext {
  conversationId?: string;
  destination?: Destination;
  isFirstPrompt: boolean;
  log: AgentPluginLogger;
  plugin: AgentPluginMetadata;
  requester?: Requester;
  session: AgentPluginSessionState;
  source: Source;
  state: AgentPluginState;
  userText: string;
}
```

`isFirstPrompt` means this is the first model-visible user prompt in the
current agent session projection. It is the only prompt lifecycle flag exposed
in V1.

The context must not expose:

- raw Slack clients or tokens
- raw HTTP requests
- raw Pi internals
- continuation, resume, retry, or lease state
- cross-plugin state
- model messages outside the safe hook-specific context

### Plugin Session Append State

Prompt hooks may use per-session append state to track deterministic plugin
bookkeeping such as memories already injected into the model-visible prompt.

```ts
interface PluginSessionStateAppend {
  key: string;
  value: unknown;
}

interface AgentPluginSessionState {
  list<T = unknown>(
    key: string,
  ): Promise<Array<{ createdAtMs: number; value: T }>>;
}
```

Rules:

1. Session state is implicitly namespaced by plugin name. Plugin code never
   supplies a plugin name.
2. Plugins can read only their own session append state.
3. Session state is append-only in V1.
4. Keys must be short validated strings.
5. Values must be bounded JSON-serializable data.
6. Session state is not an authorization source. Plugins must re-check current
   visibility and access before reusing a stored id or fact.
7. Core appends session state in the same durable session-log stream used to
   reconstruct model-visible session state.
8. Session state is plugin-visible bookkeeping, not automatically model-visible
   prompt text.

The memory plugin can use this surface to record injected memory ids:

```ts
const prior = await ctx.session.list<{ memoryIds: string[] }>(
  "injected_memories",
);
```

### Turn Observation Hook

`observeTurn(ctx)` lets plugins inspect a completed turn and enqueue passive
work such as memory extraction.

Core invokes observation hooks only after final turn state is committed far
enough that the hook cannot affect whether the user-visible turn succeeds.

Observation context should include:

- requester, source, destination, and conversation id
- bounded user-visible turn text needed by the plugin
- safe metadata about attachments and tool use
- plugin-scoped durable state and logger

Observation hooks must not receive provider credentials, raw authorization URLs,
raw Slack clients, or unrestricted transcript history. For private
conversations, observation payloads must follow the same raw-payload restrictions
as runtime code: a plugin may receive private turn text only when it is an
explicitly enabled trusted host plugin whose contract requires that payload.

Observation hooks must be best effort. A thrown observation error must be logged
with safe metadata and must not fail the already-completed user turn.

### Memory Plugin V1 Usage

The memory plugin should use the generic hooks as follows:

1. `userPrompt(ctx)` retrieves memories visible to the current requester and
   source, excludes memories already recorded in session append state, returns
   a concise memory block, and appends injected memory ids to session state.
2. `observeTurn(ctx)` records passive extraction candidates from completed
   turns into plugin durable state.
3. `heartbeat(ctx)` processes extraction, validation, embeddings, dedupe,
   supersession, expiration, and repair in bounded batches.
4. `tools(ctx)` may expose explicit management tools such as `createMemory`,
   `removeMemory`, and `listMemories`.

Memory retrieval must never depend on the model choosing a search tool. The
passive prompt hook is the recall path; tools are for explicit user management.

### Memory Tool Constraints

V1 memory management tools are context-bound:

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
   session-state append parsing fails.

## Failure Model

1. Invalid hook return shape: skip that plugin contribution, log safe metadata,
   and continue unless startup validation can catch the problem earlier.
2. Oversized contribution: truncate only if the contribution contract supports
   deterministic truncation; otherwise omit and log safe metadata.
3. Session append failure before prompt rendering: omit the corresponding
   contribution or fail the turn before the model receives mismatched context.
4. Session append failure after prompt rendering has been accepted: fail the
   turn before model execution or retry from the prior durable session state.
5. Observation hook failure: log safe metadata and do not change the completed
   turn result.
6. Malformed stored session append entries: ignore entries for plugin helper
   reads and log safe metadata; do not repair into guessed state.

## Observability

Prompt hook logs and spans may include:

- plugin name
- hook name
- contribution count
- contribution ids
- contribution text character counts
- session append keys
- outcome and duration

Prompt hook logs and spans must not include raw private prompt text, private
conversation text, provider credentials, tokens, authorization URLs, raw tool
arguments, raw tool results, or cross-plugin state.

## Verification

Use integration tests for:

- plugin system prompt contributions appear in the static prompt without
  exposing requester-specific data
- plugin user prompt contributions appear in model-visible user prompt context
- user prompt hooks run for every user prompt
- `isFirstPrompt` is true only for the first model-visible user prompt in the
  current session projection
- plugin session append state is implicitly namespaced by plugin
- plugins cannot read another plugin's session state
- session appends commit only when the corresponding prompt contribution result
  is accepted
- private conversation prompt contribution payloads are redacted from logs,
  traces, and dashboard APIs

Use unit tests for:

- hook return-shape validation
- session state key and value bounds
- deterministic plugin ordering
- memory tool schema rejection of model-supplied actor or destination fields

Use evals for:

- passive memory recall without explicit search tool use
- explicit create/list/remove memory workflows
- duplicate memory injection avoidance across follow-up prompts
- secret rejection in explicit and passive memory paths

## Related Specs

- `./agent-prompt.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-heartbeat.md`
- `./identity.md`
- `./data-redaction-policy.md`
- `./harness-tool-context.md`
