## Context

Junior traces runtime workflows through Sentry spans using OpenTelemetry-style semantic attributes. `packages/junior/src/chat/logging.ts` provides `withSpan`, `setSpanAttributes`, and `setSpanStatus`; Pi and sandbox paths also use Sentry inactive/active spans directly where streaming lifecycle requires manual span end control.

Tracing is used for operation timing and hierarchy. It should be low-noise and lifecycle-oriented, not a span for every helper call.

## Prior Art

- OpenTelemetry traces define spans as units of work grouped by trace id with parent/child relationships and attributes: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry semantic conventions define GenAI spans, `gen_ai.operation.name`, chat/tool attributes, content capture, and usage attributes: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- OpenTelemetry semantic conventions define process execution attributes such as executable name, args, and exit code: https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/
- OpenTelemetry draft MCP semantic conventions define MCP and JSON-RPC attributes for MCP tool calls: https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/
- Sentry Node tracing supports `startSpan`, `startInactiveSpan`, `withActiveSpan`, span attributes, status, and manual span closure: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/

## Local Evidence

- `specs/tracing.md`
- `specs/instrumentation.md`
- `specs/logging.md`
- `specs/otel-semantics.md`
- `specs/security-policy.md`
- `packages/junior/src/chat/logging.ts`
- `packages/junior/src/chat/pi/client.ts`
- `packages/junior/src/chat/pi/traced-stream.ts`
- `packages/junior/src/chat/tools/agent-tools.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- `packages/junior/src/chat/sandbox/sandbox.ts`
- `packages/junior/src/chat/sandbox/session.ts`
- `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`
- `packages/junior/tests/unit/logging/with-span.test.ts`
- `packages/junior/tests/unit/pi/client.test.ts`
- `packages/junior/tests/unit/chat/pi/traced-stream.test.ts`
- `packages/junior/tests/unit/tools/agent-tools.test.ts`
- `packages/junior/tests/unit/mcp/tool-manager.test.ts`

## Behavior Extraction

- `withSpan(name, op, context, callback, attributes)` creates Sentry spans and merges inherited log context with normalized attributes.
- Direct text completions create `ai.chat_completion` spans with `op: gen_ai.chat`.
- Pi agent stream function creates one inactive `gen_ai.chat` span per LLM call/loop iteration and closes it when the returned stream result settles.
- Chat spans include provider, operation, model, input messages, system instructions, output messages, finish reasons, response model, and usage attributes when available.
- Tool calls create `execute_tool <tool>` spans with `op: gen_ai.execute_tool`, tool name, description, call id, arguments, and result attributes.
- MCP tool calls add `mcp.method.name` and error attributes; future keys are governed by `otel-semantics`.
- Sandbox manager spans major lifecycle boundaries: acquire, get/reuse probe, create, snapshot resolution/build/install/capture, network policy update, sync skills, bash tool init, process exec, keepalive, and stop.
- Bash/process spans set executable, exit code, stdout/stderr byte counts, error type, and status.
- Best-effort keepalive failure is swallowed; tracing/logging may observe it but should not fail user workflows.

## Open Questions / Undefined Behavior

| Question                                                                            | Current Evidence                                                                    | Candidate Decision                                                                                                            | Status |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| Should root chat-turn span names be fully standardized here?                        | `tracing.md` lists examples; many surfaces use existing composition roots.          | Keep lifecycle categories now; standardize exact root names when chat-runtime OpenSpec is consolidated.                       | open   |
| Should every `gen_ai.invoke_agent` span be required to have `gen_ai.chat` children? | Prose says yes; current tests focus on chat child creation.                         | Keep requirement; verify per agent integration when tracing is changed.                                                       | open   |
| How should Pi stop reasons map to OTel canonical finish reasons?                    | Code comment notes raw Pi values may differ.                                        | Record as open gap for `otel-semantics` or Pi integration cleanup.                                                            | open   |
| Should raw message content be captured by default?                                  | Current code captures serialized content in some paths and metadata mode in others. | Keep capture policy bounded by security and per-call mode; future changes should prefer metadata where content is not needed. | open   |
| Are all sandbox required spans covered by tests?                                    | Implementation contains spans; targeted tests focus more on behavior.               | Treat full sandbox span matrix as verification gap unless tracing is touched.                                                 | open   |

## Decisions

### Decision: Trace meaningful lifecycle boundaries

Tracing should show workflow, AI, tool, MCP, and sandbox lifecycle timing without adding low-value helper spans.

### Decision: Manual span control is allowed for streams

Streaming model calls may use inactive spans and explicit end/error handling because callback-scoped spans cannot naturally cover asynchronous stream completion.

### Decision: Span payload capture is constrained

Span attributes may include serialized prompt/tool data only under explicit capture policy and after redaction/bounding. Sensitive or unbounded content belongs outside spans.

## Verification Strategy

- Unit tests for direct chat span creation and post-completion attributes.
- Unit tests for streamed agent-loop chat spans, inherited context, end-on-success, error status, and exactly-once span closure.
- Unit tests for tool spans and MCP span annotations.
- Unit or integration tests for sandbox spans only when span behavior changes; product sandbox behavior tests should avoid incidental tracing assertions.
- Manual/backend verification for parent/child relationships and dashboard queries.
