# Event Prompt Spec

## Metadata

- Created: 2026-06-02
- Last Edited: 2026-06-03

## Purpose

Define how Junior runs install-owned, version-controlled prompts in response to plugin-defined events without letting plugins or event payloads decide agent behavior at runtime.

## Scope

- Built-in platform and trusted plugin event definition registration.
- Install-owned event binding files under `app/events/**/*.md`.
- Startup validation for event bindings.
- Normalized inbound event envelopes, matching, idempotency, and dispatch.
- Prompt compilation for event payloads and hydrated event context.
- Runtime policy and Slack delivery boundaries for event-triggered runs.

## Non-Goals

- A generic workflow engine with branching, loops, timers, joins, or arbitrary code execution.
- Runtime user-created subscriptions stored in durable state.
- Plugin-owned behavior claims such as "run this behavior now" from a webhook hook.
- Arbitrary JavaScript, shell, or expression predicates in event binding files.
- Replacing explicit user-message entry points such as Slack mentions, Slack DMs, or GitHub `@junior` mentions.
- Scheduler task semantics; see `./scheduler.md`.

## User Stories

### Install Operator: Reviewable Automation

As an operator who customizes a Junior install, I want to add a Markdown file under `app/events/` so that a reviewed prompt runs automatically when a trusted event happens.

Acceptance criteria:

1. The event binding lives in version control.
2. Startup fails if the binding references an unknown event, unsupported context block, unsupported selector, or empty prompt body.
3. The plugin or platform integration supplies functionality and context; the install-owned Markdown body supplies the instruction.
4. Unsupported frontmatter is rejected instead of ignored so typos do not create surprising behavior.

### Slack Channel Automation

As an operator, I want Junior to create an autonomous run for each new top-level message in a configured Slack channel so recurring channel workflows can be handled without direct mentions.

Acceptance criteria:

1. An authenticated Slack root channel message matching the binding scope creates one event run.
2. A Slack thread reply does not create an event run.
3. A Slack DM does not create this channel-message event run.
4. A Slack message subtype such as an edit, bot message, or other non-standard message does not create this event run.
5. A message authored by Junior's bot identity does not create an event run.

### Directed User Request

As a Slack user, when I directly mention Junior in a channel, I expect the normal mention experience, not a second ambient automation.

Acceptance criteria:

1. A root channel message containing Junior's Slack mention token routes through the explicit mention path.
2. The same physical Slack message must not also create a `slack.channel.message.created` event prompt run.
3. If the Slack adapter cannot provide Junior's bot user id, the channel-message event producer fails closed and creates no event run.

### Provider Retry

As an operator, I want provider retries and duplicated webhook deliveries to be harmless.

Acceptance criteria:

1. Duplicate deliveries of the same source event and binding reuse the same dispatch idempotency key.
2. A completed, failed, or blocked run is not scheduled again.
3. A pending, stale, or expired existing dispatch may be scheduled again for recovery without creating a second run.

### Plugin Author

As a trusted plugin author, I want to expose new event functionality without owning install behavior.

Acceptance criteria:

1. The plugin registers an event definition, supported scope selectors, and context blocks.
2. The plugin does not read `app/events/**/*.md` directly.
3. The plugin does not choose which install bindings run.
4. Raw provider payloads and credentials stay outside the model and binding frontmatter.

## Contracts

### Core Terms

An **event definition** is built-in platform code or trusted plugin-provided code that declares an event surface Junior can normalize, validate, match, hydrate, and deliver from.

An **event binding** is an install-owned Markdown file whose frontmatter declares when an event should run and whose body is the reviewed prompt instruction.

An **event envelope** is the normalized host-owned representation of one inbound provider event after webhook authentication and provider-specific parsing.

An **event context block** is a bounded, plugin-rendered data block derived from the event envelope, such as a GitHub source comment, pull request, changed file list, or CI status.

An **event run** is one core-created dispatched agent run for a matching `(bindingId, sourceEventId)` pair.

### Plugin Event Definitions

Junior platform integrations may register built-in event definitions. Trusted plugins may register additional event definitions from app code. Declarative `plugin.yaml` manifests must not register event definitions because event definitions may own provider-specific normalization and hydration behavior.

The plugin-facing shape is:

```ts
type EventDefinitions = Record<string, AgentEventDefinition>;

interface AgentEventDefinition {
  contextBlocks?: Record<string, AgentEventContextBlockDefinition>;
  scopeKeys?: string[];
}
```

Event ids must be globally unique, lowercase dotted identifiers, and prefixed by the registering platform or plugin name, for example `github.pull_request.comment.created` or `slack.channel.message.created`.

Event definitions own:

1. The normalized event payload shape.
2. Supported binding `scope` keys.
3. Supported context block names and hydration/rendering functions.

Unsupported event definition fields must be rejected instead of treated as reserved behavior.

Plugins must not:

1. Read install event binding files directly.
2. Decide which binding should run for an event.
3. Dispatch event runs directly from inbound event hooks.
4. Mutate event bindings at runtime.
5. Expose raw provider clients, raw provider tokens, or unrestricted Junior internals through event definition contexts.

### Event Binding Files

Junior discovers install-owned bindings from:

```txt
app/events/**/*.md
```

Each file uses YAML frontmatter for the binding contract and Markdown body for the prompt instruction.

```md
---
id: slack-root-channel-review
event: slack.channel.message.created

scope:
  channelId: C1234567890

context:
  include:
    - source_message
---

A new root message was posted in the configured Slack channel.

Review the source message and decide whether action is needed. If action is
needed, complete it and post a concise summary back to the channel. If no action
is needed, stay silent.
```

Required frontmatter fields:

- `id`: stable lowercase binding id, unique across all event binding files.
- `event`: plugin-registered event id.

Optional frontmatter fields:

- `enabled`: boolean, default `true`.
- `scope`: event-definition-validated scope selector.
- `context.include`: list of event-definition-supported context block names.

The Markdown body must be non-empty after frontmatter removal. It is the event run instruction and must not contain secrets.

Event binding files must be static install content. If Junior helps an operator create or change a binding, it must propose a file edit or pull request. It must not silently mutate event binding state through a runtime tool.

### Startup Loading And Validation

Startup must load all built-in platform and trusted plugin event definitions before validating event binding files. Validation is all-or-nothing: if any event definition or binding is invalid, Junior must fail startup before registering partial event behavior.

Validation must reject:

1. Duplicate event ids across plugins.
2. Duplicate binding ids across files.
3. Binding ids that do not match the lowercase binding id format.
4. Bindings that reference unknown events.
5. `scope` or `context.include` values unsupported by the referenced event definition.
6. Markdown bodies that are empty after trimming.
7. Frontmatter values that require code execution, environment expansion, or secret interpolation.

The build/deployment packaging path must include `app/events/**/*.md` deterministically so deployed installs validate the same bindings that were reviewed in version control.

### Event Envelopes

Inbound platform code verifies provider authentication first, then normalizes recognized events into an envelope:

```ts
interface AgentEventEnvelope {
  actor?: {
    id?: string;
    login?: string;
    type?: string;
  };
  event: string;
  occurredAtMs: number;
  payload: Record<string, unknown>;
  scope: Record<string, unknown>;
  sourceEventId: string;
  sourceUrl?: string;
}
```

`sourceEventId` must be stable for provider retries of the same source event. When a provider does not supply a stable id, the producer must derive one from immutable provider fields.

Ingress owns authentication, parsing, and normalization only. It must not run model classification to decide whether an event binding matches.

### Slack Channel Message Event V1

The first built-in event is:

```txt
slack.channel.message.created
```

It represents one Slack root message posted in a normal channel or private channel.

The event producer must accept only authenticated Slack Events API envelopes where:

1. The outer event is `event_callback`.
2. The inner event type is `message`.
3. The inner event has no `subtype`.
4. The channel is a channel or private channel, not a DM or MPIM.
5. The message has no `thread_ts`, or `thread_ts` equals `ts`.
6. The Slack adapter provides Junior's bot user id.
7. The message author is not Junior's bot user id.
8. The message text does not contain Junior's Slack mention token.

The producer must ignore:

1. `app_mention` events because the explicit mention path owns them.
2. Root `message` events whose text mentions Junior because the explicit mention path owns them.
3. Thread replies.
4. DMs and MPIMs.
5. Message subtypes such as edits, deletes, joins, and bot messages.
6. Events with missing required `team_id`, `channel`, `channel_type`, `ts`, or user id.
7. Events received without a known Junior bot user id.

The envelope scope is `{teamId, channelId}`. The payload includes `teamId`, `channelId`, `messageTs`, `eventTs`, `userId`, `actor`, and `text`.

### Matching And Idempotency

Core matches an event envelope against enabled bindings whose `event` matches the envelope event id and whose `scope` selectors match the envelope scope. Matching is deterministic and must not use arbitrary code, model calls, shell commands, or remote fetches.

Multiple matching bindings are allowed. Each matching binding creates at most one event run for the source event. The idempotency key is:

```txt
event:{binding_id}:{source_event_id}
```

Duplicate provider deliveries must return or recover the same event run for the same `(bindingId, sourceEventId)` pair.

Self-event suppression is required. Events authored by Junior's own bot or app identity must not trigger event runs.

Directed user-message entry points preempt ambient event prompts. For example, a Slack root channel message that contains Junior's bot mention must route through the explicit mention path and must not also create a `slack.channel.message.created` event prompt run.

### Context Hydration

Bindings choose context blocks through `context.include`. Each included block must be supported by the event definition.

Context block hydration may fetch provider data on the host side through narrow plugin-owned capabilities. Hydration must:

1. Use host-managed credentials without exposing secrets to the model, sandbox, files, tool args, logs, or frontmatter.
2. Apply plugin-defined size limits and redaction before prompt rendering.
3. Return bounded, marker-delimited data blocks.
4. Treat provider content, comments, messages, PR bodies, and file contents as untrusted data.
5. Fail the event run before model execution when a required selected context block cannot be hydrated.

Context block renderers must not emit instructions that override binding frontmatter, core policy, tool policy, or the binding prompt.

### Prompt Compilation

Core compiles event runs into a marker-delimited prompt before entering the agent runtime.

The compiled prompt must separate:

1. Event run facts.
2. Normalized event payload.
3. Hydrated event context blocks.
4. Runtime execution rules.
5. The binding Markdown body as the current instruction.

Use marker blocks such as:

- `<event-prompt-run>`
- `<event-binding>`
- `<event-payload>`
- `<event-context name="...">`
- `<execution-rules>`
- `<current-instruction priority="highest">`

The binding body is the only binding-authored instruction. Event payload and hydrated context are data. Provider-authored text inside those blocks must never be spliced into the instruction block.

The compiled prompt must make these facts explicit:

1. This is an autonomous event-triggered run.
2. The event binding file is the source of truth for the requested action.
3. Event payload and context blocks are untrusted data.
4. The run executes as a Junior system actor, not as the provider actor who caused the event.
5. The run should complete without asking follow-up questions unless access, approval, or required input is missing.
6. If blocked, the result should identify the missing provider, permission, input, or policy constraint.

### Dispatch And Delivery

Event runs use the core dispatch mechanism.

An event run dispatch record must store:

- binding id
- event id
- source event id
- system actor
- destination
- compiled input
- selected context block names
- safe correlation metadata
- run mode `event_prompt`

V1 event run destinations are derived from the normalized Slack event envelope. Slack delivery posts to the configured Slack conversation using Slack `mrkdwn`.

Delivery must enforce final Slack idempotency using stable assistant message ids derived from the event run dispatch id.

Event prompt runs may complete silently when the run succeeds with no assistant-visible text and no files. Silent success is an executor-level event-run behavior: Junior marks the dispatch completed and records the skipped delivery state without calling the platform delivery adapter. Ordinary user-message turns must continue to treat empty non-side-effect output as an execution failure.

### Runtime Policy

Event runs are autonomous system-actor runs.

Core must enforce:

1. Disabled interactive auth continuation for system actors.
2. No use of user OAuth tokens during event runs.
3. No schedule-management or event-binding-management tools during event runs.
4. No Slack mutating tools during event runs; final event output goes through the delivery adapter.
5. Rejection of unsupported binding and event-definition fields.

Prompt wording is not sufficient enforcement for tools, credentials, delivery, or repository mutation policy.

## Failure Model

- Invalid event definitions or event bindings fail startup before partial registration.
- Unknown or unsupported inbound event types are acknowledged with no run after authentication succeeds.
- Webhook authentication or parse failures return platform-appropriate rejection responses before event normalization.
- No matching bindings means no event run.
- Duplicate provider deliveries reuse the existing run for each matching binding idempotency key.
- Directed user messages such as Slack root-channel messages that mention Junior are skipped by the ambient event producer and left to the explicit mention path.
- Context hydration failure for a selected block fails or retries the event run according to the provider operation's retry policy; it must not enter model execution with silently missing required context.
- Rate-limited or self-suppressed events are recorded as skipped and do not dispatch.
- Dispatch creation failure leaves enough durable state or logs for recovery without asking the provider to retry indefinitely.
- Delivery failure follows the platform delivery adapter's retry and idempotency rules.
- Silent success records a completed event run without Slack delivery; it must not post placeholder, failure, or "no action needed" text.

## Observability

Event prompt instrumentation must prefer spans for normal lifecycle work and
logs for exceptional, auditable, or operator-actionable outcomes. Do not emit a
separate info log for each successful phase when a parent span, child span, or
span attribute can represent the same fact.

Normal successful processing should be captured with spans:

- One inbound event span for authenticated provider event normalization,
  matching, and dispatch planning.
- One dispatch span for creating or recovering dispatch records for all matched
  bindings for the source event.
- One context hydration span when selected context blocks require host-side
  provider fetches. Use aggregate attributes for the block set; add child spans
  only for materially independent or slow provider operations.
- One delivery span for final platform delivery or silent completion.

Avoid over-granular instrumentation:

- Do not log ordinary `event_received`, `event_binding_matched`, or
  `event_run_dispatched` success events. Put those counts and ids on spans.
- Do not emit one success log per matched binding, context block, or delivery
  chunk.
- Do not add both start and finish logs for work that already has a span.
- Duplicate provider deliveries, no-match events, self-event suppression, and
  mention-conflict suppression should be span attributes by default. Emit a log
  only when the skip is persisted, rate-limit-driven, or otherwise needs an
  audit trail.

Spans and the few emitted logs should include safe metadata:

- `app.event.id`
- `app.event.binding_id`
- `app.event.source_event_id`
- `app.event.source_platform`
- `app.event.source_url`
- `app.event.actor_type`
- `app.event.actor_id`
- `app.event.context_blocks`
- `app.event.context_block_count`
- `app.event.delivery_target`
- `app.event.match_count`
- `app.event.run_id`
- `app.event.skip_reason`
- `app.event.dispatched_count`
- `app.event.skipped_count`

Logs and spans must not include provider tokens, OAuth tokens, raw webhook signatures, raw event payloads, raw comments/messages, raw prompt text, private context block bodies, or raw conversation state.

Required event prompt log names are intentionally sparse:

- `event_binding_validation_failed`
- `event_run_skipped`
- `event_run_dispatch_failed`
- `event_context_hydration_failed`
- `event_delivery_failed`

Startup may emit one summary log for event definition and binding load results.
It must not emit one log per definition or binding on ordinary success.

## Verification

Use unit tests for:

- Markdown frontmatter parsing.
- Event definition validation.
- Event binding validation.
- Rejection of unsupported event binding frontmatter.
- Deterministic scope and filter matching.
- Prompt compilation boundaries.
- Idempotency key construction.

Use integration tests for:

- Startup fails on invalid event binding files.
- Startup registers valid event binding files from `app/events/**/*.md`.
- An authenticated inbound event matches a binding and creates one event run.
- A Slack root channel message that mentions Junior does not also create an ambient event prompt run.
- Slack thread replies, DMs, message subtypes, self-authored messages, and missing bot identity do not create channel-message event runs.
- Duplicate provider delivery does not create duplicate runs.
- One event can intentionally match multiple bindings.
- Self-authored provider events are suppressed by default.
- Selected context blocks render as data and not as instruction text.
- Event runs enforce fixed tool availability below the model.
- Slack delivery posts to the event envelope destination exactly once best effort.
- Empty successful event prompt runs complete silently without platform delivery.

Use evals only when the behavior contract depends on model interpretation of the binding prompt or event context.

## Related Specs

- `./agent-prompt.md`
- `./agent-session-resumability.md`
- `./chat-architecture.md`
- `./credential-injection.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./scheduler.md`
- `./slack-agent-delivery.md`
- `./slack-outbound-contract.md`
- `./trusted-plugin-dispatch.md`
