# Slack Rendering Spec

## Metadata

- Created: 2026-04-17
- Last Edited: 2026-04-17

## Changelog

- 2026-04-17: Initial draft of the render-intent layer, plugin renderer registry, and Work Object boundary for Slack delivery.
- 2026-04-17: Dropped Work Objects. Replaced the declarative plugin-template registry with a native-intent palette the model selects from; plugins now teach intent usage through SKILL.md rather than YAML templates. Collapsed durable-entity lane; lanes are now final reply and in-flight progress.
- 2026-04-17: Added the Intent Delivery Mechanism section (ToolStrategy via the native `reply` tool, Renderer pattern). Documented the single-tool discriminated-union shape, capture-onto-`AssistantReply` plumbing, and the Renderer vs Terminator trade-off.
- 2026-04-17: Removed phased-rollout framing. The rendering engine ships as one coherent feature: all six intent kinds render end-to-end from the same plumbing. Strengthened the plugin guidance model to cover both _when_ to use an intent and _how_ the plugin's domain objects populate the intent's structured fields.

## Status

Draft

## Purpose

Define the canonical rendering contract between Junior's assistant output and Slack delivery so visible replies and in-flight progress use the same presentation boundary.

Slack presentation choices are expressed as a small, closed palette of render intents owned by core code. The model selects an intent and supplies structured fields. Core turns that into Slack blocks and top-level fallback text before calling the outbound boundary.

This spec sits in front of `slack-agent-delivery-spec.md` (reply delivery semantics) and `slack-outbound-contract-spec.md` (outbound Slack API safety). It does not change either of those contracts.

## Scope

- The native render-intent palette that Junior exposes to the model.
- The two rendering lanes: final reply and in-flight progress.
- How plugins influence intent usage for their domain objects.
- Fallback, degradation, and accessibility rules for Slack-native blocks.
- Verification shape for intent selection, block translation, and fallback behavior.

## Non-Goals

- Replacing the visible reply delivery contract defined in `slack-agent-delivery-spec.md`.
- Replacing the outbound boundary defined in `slack-outbound-contract-spec.md`.
- Reintroducing visible freeform text streaming as the default reply path.
- Letting the model author arbitrary Slack Block Kit payloads directly.
- Shipping a declarative plugin template DSL for rendering. Plugins are YAML manifests plus SKILL.md content; rendering code lives in core, and plugins teach intent usage through prose and examples.
- Supporting Slack Work Objects in this revision. Work Objects are a separate Slack primitive for durable, actionable records; they are out of scope until the render-intent layer has shipped end-to-end and there is a clear product reason to own upstream-state sync.
- Encoding presentation data inside plugin manifests as static JSON.
- Treating logs, tracing, or status telemetry as rendering contracts.
- Specifying chart or image-generation surfaces. Slack still receives those as image attachments with a concise textual takeaway.

## Contracts

### 1. Render-Intent Palette

1. Junior core owns a closed set of render-intent kinds. The initial set is:
   - `plain_reply`
   - `alert`
   - `summary_card`
   - `comparison_table`
   - `result_carousel`
   - `progress_plan`

2. Intents are native primitives exposed to the model through the turn's structured output surface, alongside tool calls. The model selects an intent kind and supplies structured fields. The model does not author Slack blocks.

3. Core translates each render intent into a Slack view model plus top-level fallback `text` before calling the outbound boundary. Block construction, block limits, and Slack-specific shape stay in core.

4. A final reply emits at most one hero render intent per message. Additional intents for the same turn must split into separate chunks through the existing reply planner, not stack inside one message.

5. Intents that cannot be fully realized (missing fields, unsupported block version, Slack payload limits) must degrade to a lower-fidelity intent in the same lane rather than silently drop content. Degradation order is defined per lane in the Failure Model section.

### 2. Lane Separation

Render intents are partitioned into two lanes. Each lane has its own policy and cannot borrow intents from another lane.

1. Final reply lane
   - Allowed intents: `plain_reply`, `alert`, `summary_card`, `comparison_table`, `result_carousel`.
   - Governed by the finalized-reply contract in `slack-agent-delivery-spec.md`.
   - Must always produce top-level fallback `text` through the shared outbound boundary.

2. In-flight progress lane
   - Allowed surfaces: assistant status, `progress_plan` rendered via the Chat SDK `Plan` object, optional `task_update` / `plan_update` stream chunks.
   - Must not carry the final answer. A completed `Plan` is not a substitute for the final reply.
   - Progress-lane writes remain best effort and must not sit on the critical path for tool or model execution, per the long-running status contract.

### 3. Intent Selection Rules

The model is instructed to choose a render intent from the final reply lane using the following selection rules. These rules are the product contract for intent choice.

1. `alert`: the main point is urgency, risk, a blocker, an authorization requirement, a destructive decision, or a partial failure that changes what the user should do next.
2. `summary_card`: the answer is best understood as one record with status, owner, priority, and 1-3 next actions.
3. `comparison_table`: the answer is driven by small structured comparisons that remain scannable. Tables must not be used as a formatting trick for prose.
4. `result_carousel`: the user asked for a small set (2-5) of comparable objects to browse, inspect, or pick from.
5. `progress_plan`: multi-step long-running work where structured task state is useful before the final reply. Progress-lane only.
6. `plain_reply`: used when none of the rich intents add value, or when the answer is prose.

Intent selection replaces the current "emit `slack-mrkdwn` and avoid tables" prompt bias for final replies. `plain_reply` preserves the current mrkdwn rendering path so no behavior changes for replies that stay prose.

### 4. Core Render Pipeline

1. Assistant output declares a render intent kind plus structured fields appropriate to that intent.
2. Core validates the intent payload against the declared schema for that kind. Validation failure degrades to `plain_reply` with the structured-field-derived fallback text.
3. Core resolves the intent to a Slack view model through the core renderer for that intent kind. There is one core renderer per intent kind; renderers are owned by core, not plugins.
4. Core always derives a top-level `text` fallback from the same structured fields used to build blocks.
5. Core passes the resulting blocks plus fallback text to the shared outbound boundary in `slack-outbound-contract-spec.md`. Outbound rendering rules, chunking, and footer attachment are unchanged.
6. Render-time failures (unknown intent kind, validation failed, payload exceeds Slack block limits) must degrade to `plain_reply` using the same fallback text. Degradation is an observable event, not a silent no-op.

### 4a. Intent Delivery Mechanism

Render intents reach core through the agent's tool surface, not through a structured-output channel on the final assistant message. This is a deliberate choice between two established patterns:

1. _ToolStrategy_ (chosen). A native `reply` tool accepts the render intent as its input. `stop_reason: "tool_use"` is a legitimate terminal state in both Anthropic and OpenAI APIs, so the turn can end on a `reply` call without a trailing assistant text message. Schema enforcement happens at the provider before any payload reaches core.
2. _ProviderStrategy_ (not used). The assistant's text itself is constrained to an intent schema via Claude's `output_config.format` or OpenAI's `response_format: json_schema`. This requires pi-agent-core to surface the provider-native structured-output field, which it does not today. If that lands upstream, it can replace `reply` with no changes to the palette or renderers; the intent schema is the contract, the delivery mechanism is an implementation detail.

The `reply` tool has the following properties:

1. _One tool, discriminated union_. There is a single `reply` tool whose input schema is the closed discriminated union of all six intent kinds (`plain_reply`, `summary_card`, `alert`, `comparison_table`, `result_carousel`, `progress_plan`). Adding a new intent kind is a schema edit, not a new tool. This caps the tool-list cost at +1 regardless of palette size.
2. _Optional, not required_. The `reply` tool follows the _Renderer_ pattern: assistant turns that end with ordinary text still render as `plain_reply` through the existing mrkdwn path. The model is instructed to call `reply` only when a richer intent is warranted. The _Terminator_ alternative (every turn must end with `reply`) was rejected because it taxes every plain-text reply with the tool-call round-trip in exchange for uniform plumbing that core does not otherwise need. This trade-off is revisitable: if future Slack per-reply affordances (feedback buttons, context actions) require a block-bearing payload on every turn, switching to Terminator is a runtime change with no palette or renderer impact.
3. _Terminal, not recursive_. A successful `reply` call signals the end of the turn. The runtime does not feed a tool-result message back into the loop for the `reply` call; it captures the validated intent onto turn state and finalizes the reply. If the agent invokes `reply` more than once, the last invocation wins — this matches the visible behavior that only one final message is delivered per turn.
4. _Cross-validated_. The TypeBox schema on the tool is the provider-enforced contract. Core re-validates the payload with the same Zod schema that the renderer consumes, so the renderer never sees a shape the tests were not written against. Divergence between the two schemas is a loud runtime error, not a silent fallback.
5. _Captured onto `AssistantReply`_. The validated intent is surfaced on the turn's `AssistantReply` as an optional field. Delivery reads the intent (if present) and renders via the core intent renderer into blocks + fallback text; otherwise the existing plain-text path runs unchanged. This keeps the reply-delivery contract in `slack-agent-delivery-spec.md` intact.

### 5. Guidance Model

Model guidance about render intents is split into two layers so the core capability is taught in one place and plugins add only the domain-specific detail.

1. _Core capability (surface-owned)_. The Slack system prompt includes a single `<slack-output>` section that is the sole authority on what a Slack response may contain. It defines two allowed response forms: Form A (a `reply` tool call with one of the palette intents, when the tool is registered on the turn) and Form B (plain Slack mrkdwn text, with an explicit allow-list of syntax and an explicit forbid-list for GFM / CommonMark features that Slack does not render). It also names the palette, the per-intent selection rules, the "at most one `reply` per turn" rule, and when to skip `reply` entirely (ordinary prose). This section is generic across plugins — it does not reference any specific domain object — and it is the only place the palette and the mrkdwn syntax rules are taught at the model level.
2. _Plugin recipes (domain-owned)_. Plugins do not register renderers, templates, or presentation YAML; rendering code stays in core. Plugins influence intent rendering through their existing surface area (YAML manifests plus `SKILL.md` content), along two axes:
   - _When_ — which of their domain objects are best expressed as which intent kind (for example, "a pull request returned from `gh pr view` is a `summary_card`", "a Sentry search result list is a `result_carousel`").
   - _How_ — the concrete field recipe the model should populate for that entity: title shape, which labels to surface as `fields`, recommended `actions` (usually a deep link back to the source system), when to use `subtitle` vs. `body`, and any domain-specific phrasing conventions.
     Plugin recipes reference the intent names and field shapes directly but must not describe Slack block shapes, restate the palette, or restate the "when to skip `reply`" rules. Blocks are a core implementation detail and the palette is already taught by the surface.
3. This keeps the plugin contract declarative (YAML manifest plus markdown skills) and preserves the principle that plugins are not code.
4. Adding support for a new plugin-domain entity in Slack rendering does not require any core change when the existing intent set already covers the presentation. The work is an edit to that plugin's `SKILL.md`.
5. Adding a new intent kind is a core change. Intents are the shared vocabulary; the palette is not plugin-extensible.

### 6. Renderer Implementation

All six intent kinds render end-to-end through the core renderer at `packages/junior/src/chat/slack/render/renderer.ts`. Each renderer translates a validated intent view model into a Slack Block Kit payload plus a non-empty fallback `text` derived from the same structured fields. The renderers use a local TypeScript subset of Block Kit (section, header, divider, context, actions, link buttons) that maps directly to the shapes `chat.postMessage` accepts.

Slack has announced newer AI-oriented block primitives (native Card, Alert, Data Table, Carousel). When those become available in the installed `chat` / `@chat-adapter/slack` surfaces, the corresponding renderer can swap to the native shape without changing the palette, the intent schema, or the plugin guidance. That swap is an implementation change, not a new contract.

### 7. Accessibility and Fallback Rules

1. Every message delivered through the render-intent layer must carry a non-empty top-level `text` derived from the same structured fields as the blocks.
2. Alerts, summary cards, comparison tables, and carousels must be understandable from the fallback text alone. The blocks are an enhancement, not the sole carrier of meaning.
3. Actions must have clear text labels. Icon-only actions are not allowed.
4. For chart-like content, Slack delivery continues to use image uploads plus a concise textual takeaway and a download path. The render-intent layer does not introduce a chart intent in this spec.

### 8. Prompt and Model Behavior

1. A single `<slack-output>` section in the system prompt is the sole authority on what a Slack response may contain. It defines two permitted response forms — Form A (a `reply` tool call with one palette intent, when the tool is registered on the turn) and Form B (plain Slack mrkdwn text with an explicit allow-list of syntax and an explicit forbid-list for GFM / CommonMark features) — and forbids any third shape. It names the palette, gives the selection rules from section 3, states the one-`reply`-per-turn rule, tells the model to skip `reply` for ordinary prose, and lists the mrkdwn syntax the model may use versus the GFM constructs (tables, `**bold**`, `[label](url)`, `##` headings, etc.) it must not emit.
2. The prompt does not describe Slack Block Kit JSON shapes and does not let the model author blocks. Free-text fields inside an intent (body, subtitles, action labels, table cells) must follow the Form B mrkdwn rules.
3. Progress-lane affordances (status, `progress_plan`) are offered to the model only when the turn is expected to be long-running or tool-heavy, consistent with the long-running status contract.
4. Plugin `SKILL.md` content extends the selection rules with plugin-specific recipes (for example, "when returning a GitHub pull request, a `summary_card` with title, author, state, and review status is usually best"). Plugin guidance cannot expand or redefine the palette itself and should not restate what `<slack-output>` already teaches.

### 9. First-Party Coverage Targets

First-party plugin intent-usage coverage, documented so plugin authors know what is expected from their `SKILL.md` and prompt content:

1. Sentry: issue summary card, incident summary card, regression alert, issue search-results carousel.
2. Linear: task summary card, project or initiative carousel.
3. GitHub: PR summary card, issue summary card, review queue carousel.

Coverage is additive. A plugin missing guidance for a specific entity is not a violation; the model falls back to `plain_reply` with prose.

## Failure Model

1. Unknown render-intent kind or intent payload fails validation: degrade to `plain_reply` using fallback text derived from the structured fields. Record the degradation with the failing intent kind.
2. Slack block payload exceeds platform limits: degrade to the next lower-fidelity intent in the same lane (`result_carousel` -> `summary_card` -> `plain_reply`; `comparison_table` -> `plain_reply`; `alert` -> `plain_reply`). Never silently truncate blocks.
3. Missing top-level `text` fallback is a contract violation. The outbound boundary must reject messages that attach blocks without fallback text.
4. Core renderer throws: degrade to `plain_reply` with the structured-field-derived fallback text and record the failure. Renderer exceptions must not surface as Slack post failures.
5. Progress-lane writes that fail (status update, plan update) must remain best effort. They must not fail the turn or block final reply delivery.

## Observability

Render-intent decisions and degradations must be observable without adding behavior contracts to logs.

Required observability shape:

- `app.render.intent` identifies the chosen intent kind for a final reply.
- `app.render.lane` identifies the lane (`final_reply`, `progress`).
- `app.render.degraded_from` and `app.render.degraded_to` identify degradation transitions.
- Plugin attribution, where useful for debugging, is derived from the active skill set for the turn and does not need a dedicated rendering attribute.

Logs and spans remain governed by `./logging/index.md`. This spec does not add new behavior contracts backed by log assertions.

## Verification

Required verification coverage for this contract:

1. Unit: core view-model translation for each intent kind, including fallback text derivation.
2. Unit: validation of intent payload schemas. Invalid payloads degrade to `plain_reply`.
3. Unit: degradation paths (unknown intent, oversized payload, renderer throws) produce the expected lower-fidelity intent with preserved fallback text.
4. Integration: final reply lane produces one hero intent per message and always includes top-level fallback text through the shared outbound boundary.
5. Integration: progress-lane writes remain best effort and do not block or fail the turn.
6. Evals: realistic Slack conversations confirm the model selects the correct intent for alerts, single-record answers, small comparisons, small result sets, and long-running tool work.

## Related Specs

- `./slack-agent-delivery-spec.md`
- `./slack-outbound-contract-spec.md`
- `./chat-architecture-spec.md`
- `./plugin-spec.md`
- `./logging/index.md`
- `./testing/index.md`
