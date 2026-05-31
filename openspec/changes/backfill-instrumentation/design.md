## Context

Instrumentation in Junior is the umbrella for structured logs, Sentry/OpenTelemetry-style traces, semantic attribute naming, and derived metrics. The current implementation centralizes logs and spans in `packages/junior/src/chat/logging.ts`, re-exports Sentry from `packages/junior/src/chat/sentry.ts`, and uses semantic attributes across chat runtime, sandbox, Pi, MCP, tool execution, OAuth, and Slack surfaces.

This backfill should not turn the instrumentation index into a giant copy of logging and tracing. Its job is to define shared ownership, signal choice, correlation invariants, and how future contributors choose between logs, spans, and metrics.

## Prior Art

- OpenTelemetry log records define timestamp, severity, body, attributes, event name, and trace context fields; a log record with a non-empty event name is an event: https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OpenTelemetry traces model spans as units of work with trace correlation and semantic attributes: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry GenAI span conventions define standard `gen_ai.*` attributes and content-capture guidance: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- Sentry Node tracing supports `startSpan`, inactive spans, span attributes, and manual trace propagation: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/
- LogTape supports structured logging and implicit contexts through `AsyncLocalStorage` when configured with context local storage: https://logtape.org/manual/contexts

## Local Evidence

- `specs/instrumentation.md`
- `specs/logging.md`
- `specs/tracing.md`
- `specs/otel-semantics.md`
- `specs/security-policy.md`
- `packages/junior/src/chat/logging.ts`
- `packages/junior/src/chat/sentry.ts`
- `packages/junior/src/chat/pi/client.ts`
- `packages/junior/src/chat/pi/traced-stream.ts`
- `packages/junior/src/chat/tools/agent-tools.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- `packages/junior/src/chat/sandbox/sandbox.ts`
- `packages/junior/src/chat/sandbox/session.ts`
- `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`
- `packages/junior/tests/unit/logging/console-format.test.ts`
- `packages/junior/tests/unit/logging/with-span.test.ts`
- `packages/junior/tests/unit/logging/extract-gen-ai-usage-summary.test.ts`
- `packages/junior/tests/unit/pi/client.test.ts`
- `packages/junior/tests/unit/chat/pi/traced-stream.test.ts`
- `packages/junior/tests/unit/tools/agent-tools.test.ts`
- `packages/junior/tests/unit/mcp/tool-manager.test.ts`

## Behavior Extraction

- `logging.ts` is the central observability facade for logs, Sentry exception capture, log context, span creation, span attributes, span status, Chat SDK logging, and GenAI usage extraction.
- Log context is converted into semantic attributes and propagated with `AsyncLocalStorage`.
- Active Sentry spans contribute `trace_id` and `span_id` to emitted logs when available.
- `withSpan()` nests Sentry spans under current context and merges inherited log context with span-specific attributes.
- Pi direct chat calls and Pi agent streams create `gen_ai.chat` spans with request model, input/output message attributes, finish reasons, and usage attributes where available.
- Tool execution creates `gen_ai.execute_tool` spans and sets tool result attributes after execution.
- MCP tool calls add MCP/JSON-RPC semantic attributes to tool execution spans.
- Sandbox runtime code emits lifecycle spans described by `specs/tracing.md`.
- Metrics are currently policy-driven: derive from logs/spans unless a direct metric is justified.

## Open Questions / Undefined Behavior

| Question                                                                | Current Evidence                                                                                              | Candidate Decision                                                                                            | Status   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| Who approves direct metric emission?                                    | `specs/instrumentation.md` lists criteria, but no approval workflow.                                          | Require an OpenSpec change that names the signal, why logs/spans are insufficient, and alert/query ownership. | open     |
| Should instrumentation coverage assert every important span/log exists? | Testing policy says observability is not a behavior contract by default.                                      | Verify instrumentation only when it is the changed contract or prevents regression in required attributes.    | open     |
| How should non-Node/Edge runtimes propagate context?                    | Logging spec states current propagation relies on Node `AsyncLocalStorage`.                                   | Keep Node-only invariant until an Edge runtime spec exists.                                                   | deferred |
| Should metrics have a dedicated spec?                                   | Metrics are currently a policy section only.                                                                  | Keep under `instrumentation` until direct metrics are introduced.                                             | deferred |
| Which GenAI content attributes are safe to capture by default?          | Current code captures serialized messages in selected spans; security policy forbids sensitive payload leaks. | Keep detailed capture policy in `tracing` and `security-policy`.                                              | open     |

## Decisions

### Decision: Instrumentation is an umbrella capability

`instrumentation` owns shared policy and routing between signals. It does not duplicate detailed log record, span, or semantic-key requirements.

### Decision: Logs and traces are the default source for metrics

Direct metric emission remains exceptional. Future direct metrics must prove that derived metrics from `event.name`, log attributes, span durations, or span statuses are insufficient.

### Decision: Correlation is a shared invariant

Any logging or tracing change must preserve request/workflow correlation where context exists. Logs and spans may have different data models, but they must share stable semantic attributes for joining.

## Verification Strategy

- Use unit tests for deterministic facade behavior such as context merge, trace id propagation, usage extraction, and span helper semantics.
- Use targeted unit tests around Pi/tool/MCP span attributes when instrumentation is the behavior under change.
- Avoid asserting incidental log/span existence in product behavior tests.
- Use manual or backend query verification for dashboards, alerts, and direct metrics that cannot be validated locally.
