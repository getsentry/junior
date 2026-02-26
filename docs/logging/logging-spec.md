# Structured Logging Spec (OpenTelemetry Semantic Conventions)

## Goals
- Make logs consistent, structured, and queryable across the app.
- Use OpenTelemetry semantic attribute names wherever a standard exists.
- Keep one logging entrypoint (similar to `ash`'s centralized logging model).
- Guarantee trace/log correlation for request and AI workflow debugging.

## Non-goals
- Replacing Sentry tracing setup.
- Shipping a separate log backend in this phase.

## Current State (Audit)
- Core logging helper exists: `src/chat/observability.ts`.
- Callsites are concentrated in:
  - `src/chat/bot.ts`
  - `src/chat/respond.ts`
  - `src/chat/skills.ts`
  - `src/chat/output.ts`
  - `app/api/webhooks/[platform]/route.ts`
- Key inconsistencies today:
  - Mixed naming styles (`media_type`, `error`, `request.id`, `gen_ai.request.model`).
  - Message text is often prose, not stable event names.
  - Context is repeated manually instead of ambient propagation.

## Design Principles
- Centralized API: no direct `console.*` for application logging.
- Event-first logging: stable `event.name` for every log record.
- Semantic-first attributes: use OTel keys first; app keys are namespaced as `app.*`.
- Context propagation: request and workflow context auto-attached to child logs.
- Safe by default: redact sensitive values, drop oversized payloads, and keep logs JSON-safe.
- Canonical semantic key choices are documented in `docs/logging/semantics.md`.

## Logging Contract

### Record Shape
Each emitted log record follows this logical shape (transport can vary):
- `timestamp`
- `severity_text` (`DEBUG|INFO|WARN|ERROR`)
- `body` (human-readable summary)
- `event.name` (stable machine event id)
- `attributes` (flat key-value map, semantic keys preferred)
- `trace_id` (if active span)
- `span_id` (if active span)

### Message Semantics
- Every log record must include both:
  - `event.name`: stable snake_case identifier for machines, dashboards, and alert rules.
  - `body`: natural-language message for humans.
- `event.name` is the canonical grouping/filter key in tooling.
- `body` should follow plain language semantics:
  - concise
  - specific
  - past/present tense factual statement (not a promise)
  - no ambiguous placeholders like "something failed"
- Do not use `event.name` as a prose sentence and do not omit `event.name` in favor of only text.

### API Surface (`src/chat/logging.ts`)
- `log.debug(eventName, attrs?, body?)`
- `log.info(eventName, attrs?, body?)`
- `log.warn(eventName, attrs?, body?)`
- `log.error(eventName, attrs?, body?)`
- `log.exception(eventName, error, attrs?, body?)`
- `withLogContext(context, fn)` using `AsyncLocalStorage`
- `createLogContextFromRequest(...)`

All existing helpers in `observability.ts` remain as compatibility shims initially, then migrate to the new API.

## Event Naming Convention
- `snake_case` identifiers.
- Format: `<domain>_<action>[_<result>]`.
- Examples:
  - `webhook_platform_unknown`
  - `webhook_handler_failed`
  - `attachment_resolution_failed`
  - `ai_finalization_forced`
  - `skill_frontmatter_invalid`

## OpenTelemetry Semantic Attribute Policy

### Required (when available)
- `service.name`
- `service.version`
- `deployment.environment.name`
- `event.name`

### HTTP / Request
- `http.request.method`
- `url.path`
- `url.full` (when safe)
- `http.response.status_code`
- `user_agent.original` (if available)

### Messaging / Slack
- `messaging.system` = `slack`
- `messaging.destination.name` (channel identifier)
- `messaging.message.id` (message ts/id when available)
- `messaging.conversation.id` (thread id)
- `enduser.id` (requester user id)

### GenAI
- `gen_ai.request.model`
- `gen_ai.system` (provider/gateway)
- `gen_ai.operation.name` (e.g. `generate_text`)

### Error
- `error.type`
- `error.message`
- `error.stack` (only on error-level logs/events; truncated)

### Workflow / App-specific (namespaced)
Only when no semantic key exists:
- `app.workflow.run_id`
- `app.skill.name`
- `app.assistant.username`
- `app.retry.attempt`

## Attribute Rules
- Flat map only; no nested objects.
- Value types: string | number | boolean.
- `undefined`, `null`, empty string dropped.
- Arrays converted to compact summaries unless explicitly allowed.
- Large strings truncated with suffix `...`.

## Redaction Rules
- Redact known secret/token patterns before emission.
- Never log raw auth headers, API keys, or attachment bytes.
- For user content, log size/metadata by default; content only when explicitly needed and safe.

## Metrics Derivation Policy
- Default: derive metrics from log events and their attributes.
- `event.name` is the primary metric grouping key.
- Avoid direct metric emission when equivalent counters/histograms can be computed from existing logs.
- Introduce direct metrics only when log/span derivation is insufficient due to:
  - very high-frequency signals and storage/query cost limits,
  - missing attributes that cannot be safely added to logs/spans,
  - or strict low-latency alert requirements.

## Rollout Plan

### Phase 1: Foundation
- Add `src/chat/logging.ts` with:
  - typed event names (string union + fallback string)
  - semantic key helpers
  - context propagation via `AsyncLocalStorage`
  - Sentry logger transport adapter
  - console JSON fallback
- Add normalization utilities:
  - key validator (`snake_case` event names, dotted attribute keys)
  - attribute sanitizer/redactor

### Phase 2: Context Wiring
- Wire request context in `app/api/webhooks/[platform]/route.ts`.
- Ensure `trace_id`/`span_id` are attached when spans are active.
- Remove manual repeated context blocks in `bot.ts` and `respond.ts` by using `withLogContext`.

### Phase 3: Callsite Migration
- Replace all `logWarn/logError/logException` calls with event-based structured logs.
- Standardize key names at each callsite using the semantic map above.
- Keep `observability.ts` as passthrough wrappers to avoid large one-shot breaks.

### Phase 4: Guardrails
- Add tests for:
  - redaction
  - attribute sanitization
  - context propagation
  - event naming validation
- Add lint/check script to block non-conformant keys in logging calls.
- Update docs with examples and migration cheatsheet.

### Phase 5: Hardening
- Set severity guidance by domain (debug/info/warn/error).
- Reduce noisy logs and promote high-value operational events.
- Validate logs in Sentry queries and dashboards.

## Acceptance Criteria
- 100% of application logs go through `src/chat/logging.ts`.
- 0 mixed key style for migrated callsites (no `media_type` / ad-hoc keys).
- Every warning/error log has stable `event.name` and semantic attributes.
- Every emitted log has both structured `event.name` and human-readable `body`.
- Request/thread/user/model context appears automatically in child logs.
- Secret redaction tests pass.

## Migration Matrix (Initial)
- `app/api/webhooks/[platform]/route.ts`
  - unknown platform, handler failures, request lifecycle
- `src/chat/bot.ts`
  - attachment handling, thread lifecycle, handler failures
- `src/chat/respond.ts`
  - empty/fallback behaviors, retries, model/tool anomalies
  - required per-turn event: `agent_turn_diagnostics`
- `src/chat/skills.ts`
  - skill discovery/read/frontmatter parse issues
- `src/chat/output.ts`
  - output normalization fallback

## Open Questions
- Should we emit logs to local JSONL in addition to Sentry in dev (ash-style local inspectability)?
- Do we want strict compile-time enums for event names from day 1, or a soft migration with runtime validation first?
