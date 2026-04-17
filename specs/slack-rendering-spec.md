# Slack Rendering Spec

## Metadata

- Created: 2026-04-17
- Last Edited: 2026-04-17

## Changelog

- 2026-04-17: Initial draft of the render-intent layer, plugin renderer registry, and Work Object boundary for Slack delivery.

## Status

Draft

## Purpose

Define the canonical rendering contract that sits between Junior's assistant output and Slack delivery so visible replies, in-flight progress, and durable entities use the same presentation boundary.

This spec exists so Slack presentation choices are expressed as high-level render intents owned by core code, not as raw Block Kit JSON authored by the model or duplicated inside plugins.

It is a sibling to `slack-agent-delivery-spec.md` (delivery semantics) and `slack-outbound-contract-spec.md` (outbound Slack API safety). Those specs keep ownership of the reply-delivery contract and raw Slack writes. This spec only adds the presentation layer in front of them.

## Scope

- The internal render-intent types that Junior produces before delivery.
- The three rendering lanes: final reply surfaces, in-flight progress, and durable entities.
- The plugin renderer registry contract for domain objects.
- Fallback, degradation, and accessibility rules for Slack-native blocks.
- Verification shape for render-intent selection, plugin renderer resolution, and fallback behavior.

## Non-Goals

- Replacing the visible reply delivery contract defined in `slack-agent-delivery-spec.md`.
- Replacing the outbound boundary defined in `slack-outbound-contract-spec.md`.
- Reintroducing visible freeform text streaming as the default reply path.
- Letting the model author arbitrary Slack Block Kit payloads directly.
- Encoding presentation data inside plugin manifests as static JSON.
- Treating logs, tracing, or status telemetry as rendering contracts.
- Specifying chart or image-generation surfaces. Slack still receives those as image attachments with a concise textual takeaway.

## Contracts

### 1. Render-Intent Boundary

1. Junior core owns a closed set of render-intent types. The initial set is:
   - `plain_reply`
   - `alert`
   - `summary_card`
   - `comparison_table`
   - `result_carousel`
   - `progress_plan`
   - `work_object_reference`

2. The model chooses an intent kind and supplies structured fields. The model does not author Slack blocks.
3. Core code translates each render intent into a Slack view model plus top-level fallback text before calling the outbound boundary.
4. A reply emits at most one hero render intent per message. Additional intents for the same turn must split into separate chunks using the existing reply planner, not stack inside one message.
5. Intents that cannot be fully realized (missing fields, unsupported block version, Slack payload limits) must degrade to a lower-fidelity intent in the same lane rather than silently drop content. Degradation order is defined per lane below.

### 2. Lane Separation

Render intents are partitioned into three lanes. Each lane has its own policy and cannot borrow intents from another lane.

1. Final reply lane
   - Allowed intents: `plain_reply`, `alert`, `summary_card`, `comparison_table`, `result_carousel`, `work_object_reference`.
   - Governed by the finalized-reply contract in `slack-agent-delivery-spec.md`.
   - Must always produce top-level fallback `text` through the shared outbound boundary.
2. In-flight progress lane
   - Allowed surfaces: assistant status, optional `progress_plan` rendered via the Chat SDK `Plan` object, optional `task_card`-style streamed chunks (`task_update`, `plan_update`).
   - Must not carry the final answer. A completed `Plan` is not a substitute for the final reply.
   - Progress lane writes remain best effort and must not sit on the critical path for tool/model execution, per the long-running status contract.
3. Durable entity lane
   - Allowed intent: `work_object_reference`.
   - Backed by Slack Work Objects for records users will revisit, search, expand, and act on.
   - The message that references a Work Object must still carry meaningful fallback text and, when the Work Object cannot be created or resolved, must degrade to `summary_card` in the final reply lane.

### 3. Intent Selection Rules

The model is instructed to choose a render intent from the final reply lane or the durable entity lane using the following selection rules. These rules are the product contract for intent choice.

1. `alert`: the main point is urgency, risk, a blocker, an authorization requirement, a destructive decision, or a partial failure that changes what the user should do next.
2. `summary_card`: the answer is best understood as one record with status, owner, priority, and 1-3 next actions.
3. `comparison_table`: the answer is driven by small structured comparisons that remain scannable. Tables must not be used as a formatting trick for prose.
4. `result_carousel`: the user asked for a small set (2-5) of comparable objects to browse, inspect, or pick from.
5. `progress_plan`: multi-step long-running work where structured task state is useful before the final reply. Progress-lane only.
6. `work_object_reference`: the object is durable and should live in Slack as a first-class entity, not as a one-off message. Must come from a plugin renderer that declares `buildWorkObject`.
7. `plain_reply`: used when none of the rich intents add value, or when the answer is prose.

Intent selection is a product contract. It replaces the current "emit `slack-mrkdwn` and avoid tables" prompt bias for final replies.

### 4. Core Render Pipeline

1. Assistant output declares a render intent and structured fields.
2. Core resolves the intent to a Slack view model by:
   - calling the matching plugin renderer when the intent carries a plugin-domain entity, or
   - falling back to a core renderer for generic intents (`plain_reply`, `alert`, `summary_card`, `comparison_table`, `result_carousel`).
3. Core always derives a top-level `text` fallback from the same structured fields used to build blocks.
4. Core passes the resulting blocks plus fallback text to the shared outbound boundary in `slack-outbound-contract-spec.md`. Outbound rendering rules, chunking, and footer attachment are unchanged.
5. Render-time failures (unknown intent, renderer threw, payload exceeds Slack block limits) must degrade to `plain_reply` using the same fallback text. Degradation is an observable event, not a silent no-op.

### 5. Plugin Renderer Registry

1. Plugins may register one or more renderers. Renderers are code-owned TypeScript modules loaded from the plugin, not static YAML.
2. A renderer declares:
   - `match(result, context): number | null` — returns a score for the given domain entity or `null` if the renderer does not apply.
   - `buildIntent(entity, context): SlackRenderIntent` — returns the intent kind plus structured fields in the final reply lane.
   - `buildFallbackText(entity, context): string` — returns the top-level `text` fallback. Must always be non-empty when the renderer matches.
   - `buildActions?(entity, context): SlackRenderAction[]` — optional. Must not exceed Slack's documented action limits for the selected block set.
   - `buildWorkObject?(entity, context): WorkObjectPayload` — optional. Required for `work_object_reference` intents.
3. When multiple renderers match, the highest score wins. Ties are resolved by plugin registration order, which is the existing deterministic plugin load order.
4. Plugins do not author Slack Block Kit payloads. They author render intents plus structured fields. Slack block construction stays in core.
5. Renderers are invoked only after a skill from the same plugin is loaded for the turn, matching the MCP tool activation rule in `plugin-spec.md`. This keeps rendering surface alignment with active capabilities.
6. Renderer modules must not perform network calls. All data needed to render must already be on the entity supplied by the tool or skill.

### 6. SDK-First Phasing

1. Phase 1 uses capabilities already present in the installed `chat` / `@chat-adapter/slack` packages before adding Slack-specific block abstractions:
   - `Card(...)` for `summary_card`.
   - The Chat SDK `Table` element for `comparison_table`.
   - The Chat SDK `Plan` object plus `task_update` / `plan_update` stream chunks for `progress_plan`.
   - Final-message actions where follow-up workflows matter.
2. Phase 2 adds a Slack-specific renderer layer for blocks that are newer than the current Chat SDK abstractions. Initial targets are `alert`, `card`, and `carousel`. This layer sits behind the outbound boundary and must always emit top-level `text`. It must degrade cleanly when Slack block support or SDK support is unavailable.
3. Phase 3 adds Work Object support for durable records. Likely first candidates are Sentry incident, Sentry issue, Linear task, and GitHub issue or PR. Work Object creation must be plugin-owned and must not run on the critical path of final reply delivery.

The phased ordering is a contract: Phase 2 and Phase 3 additions must not land before the Phase 1 render-intent layer is the canonical path for final replies.

### 7. Accessibility and Fallback Rules

1. Every message delivered through the render-intent layer must carry a non-empty top-level `text` derived from the same structured fields as the blocks.
2. Alerts, summary cards, comparison tables, and carousels must be understandable from the fallback text alone. The blocks are an enhancement, not the sole carrier of meaning.
3. Actions must have clear text labels. Icon-only actions are not allowed.
4. For chart-like content, Slack delivery continues to use image uploads plus a concise textual takeaway and a download path. The render-intent layer does not introduce a chart intent in this spec.
5. Work Object references must still include enough fallback text to explain the record identity, state, and primary action when Slack cannot render the Work Object inline.

### 8. Prompt and Model Behavior

1. The prompt instructs the model to choose a render intent from the final reply lane instead of authoring `slack-mrkdwn` for structured answers.
2. The prompt lists the selection rules from section 3 with short examples and lets the model fall back to `plain_reply` when no rich intent fits.
3. The prompt must not describe Slack Block Kit JSON shapes or let the model author blocks.
4. Progress-lane affordances (status, `progress_plan`) are offered to the model only when the turn is expected to be long-running or tool-heavy, consistent with the long-running status contract.

### 9. Plugin Template Coverage

First-party plugin renderer coverage targets, documented as a contract so plugin authors know what is expected:

1. Sentry: issue summary card, incident summary card, regression alert, issue search-results carousel, incident Work Object, issue Work Object.
2. Linear: task summary card, project or initiative carousel, task Work Object.
3. GitHub: PR summary card, issue summary card, review queue carousel, issue or PR Work Object.

Coverage is additive. Missing a template for a specific entity must degrade to `plain_reply` with fallback text rather than block delivery.

## Failure Model

1. Unknown render intent, renderer throws, or view-model construction fails: degrade to `plain_reply` using the same structured fields' fallback text. Record the degradation with the failing intent kind and plugin name.
2. Slack block payload exceeds platform limits: degrade to the next lower-fidelity intent in the same lane (`result_carousel` -> `summary_card` -> `plain_reply`; `comparison_table` -> `plain_reply`; `alert` -> `plain_reply`). Never silently truncate blocks.
3. Work Object creation fails or is unsupported by the workspace: degrade to `summary_card` with an "open in source" action and preserve fallback text.
4. Missing top-level `text` fallback is a contract violation. The outbound boundary must reject messages that attach blocks without fallback text.
5. Plugin renderer attempts a network call or depends on ambient state: contract violation. Renderers must be pure over their arguments.
6. Progress-lane writes that fail (status update, plan update) must remain best effort. They must not fail the turn or block final reply delivery.

## Observability

Render-intent decisions and degradations must be observable without adding behavior contracts to logs.

Required observability shape:

- `app.render.intent` identifies the chosen intent kind for a final reply.
- `app.render.lane` identifies the lane (`final_reply`, `progress`, `durable_entity`).
- `app.render.plugin` identifies the plugin owning the renderer when applicable.
- `app.render.degraded_from` and `app.render.degraded_to` identify degradation transitions.
- Work Object creation emits a dedicated event so Work Object failures are distinguishable from message-post failures.

Logs and spans remain governed by `specs/logging/index.md`. This spec does not add new behavior contracts backed by log assertions.

## Verification

Required verification coverage for this contract:

1. Unit: core render-intent to Slack view-model translation for each intent kind, including fallback text derivation.
2. Unit: degradation paths (unknown intent, oversized payload, Work Object failure) produce the expected lower-fidelity intent.
3. Unit: plugin renderer registry scoring, tie-breaking by registration order, and activation gating behind loaded skills.
4. Integration: final reply lane produces one hero intent per message and always includes top-level fallback text through the shared outbound boundary.
5. Integration: progress-lane writes remain best effort and do not block or fail the turn.
6. Integration: Work Object references degrade to `summary_card` when creation fails and preserve fallback text.
7. Evals: realistic Slack conversations confirm the model selects the correct intent for alerts, single-record answers, small comparisons, small result sets, and long-running tool work.

## Related Specs

- `./slack-agent-delivery-spec.md`
- `./slack-outbound-contract-spec.md`
- `./chat-architecture-spec.md`
- `./plugin-spec.md`
- `./logging/index.md`
- `./testing/index.md`
