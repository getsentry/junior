# Tracing Backfill Worksheet

## Canonical Spec

- New spec: `tracing`
- Existing source: `specs/tracing.md`

## Local Artifacts Reviewed

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

## External Sources

- OpenTelemetry traces concepts: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry GenAI span conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- OpenTelemetry process attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/
- OpenTelemetry MCP attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/
- Sentry Node tracing instrumentation: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/

## Current Behavior Summary

- Span helpers centralize callback-scoped spans and active span mutation.
- Direct chat completion uses `ai.chat_completion` / `gen_ai.chat`.
- Pi agent loop streaming creates manual `chat <model>` / `gen_ai.chat` spans for each model call.
- Tool execution uses `execute_tool <tool>` / `gen_ai.execute_tool`.
- MCP tool execution adds MCP method attributes.
- Sandbox lifecycle creates spans around acquire, reuse/get, create, snapshot, sync, bash-tool init, bash execution, keepalive, and stop.
- Error status is set on failed model calls, stream rejection, and nonzero sandbox process exits.

## Undefined Behavior

| Question                           | Current Evidence                                        | Candidate Decision                               | Status |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------ | ------ |
| Exact root workflow names          | Spec examples exist; implementation spans vary by path. | Standardize in future chat-runtime tracing work. | open   |
| Agent invoke/chat parent guarantee | Prose says required; unit tests cover chat children.    | Verify in integration when tracing changes.      | open   |
| Finish reason canonicalization     | Code currently emits raw Pi stopReason values.          | Fix under `otel-semantics`/Pi tracing cleanup.   | open   |
| Full sandbox span matrix tests     | Implementation has spans; tests focus elsewhere.        | Add only when span behavior changes.             | open   |

## Migration Notes

- Keep `specs/tracing.md` until accepted; then use it as rationale/index or archive overlapping requirements.
- Link `tracing` to `otel-semantics` for exact attribute key ownership.

## Validation

- `openspec validate backfill-tracing --strict` passed.
