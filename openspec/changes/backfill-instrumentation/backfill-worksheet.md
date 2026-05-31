# Instrumentation Backfill Worksheet

## Canonical Spec

- New spec: `instrumentation`
- Existing source: `specs/instrumentation.md`

## Local Artifacts Reviewed

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

## External Sources

- OpenTelemetry logs data model: https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OpenTelemetry traces concepts: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry GenAI span conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- Sentry Node tracing instrumentation: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/
- LogTape contexts: https://logtape.org/manual/contexts

## Current Behavior Summary

- `logging.ts` is both the logging facade and high-level span helper boundary.
- Sentry is isolated behind `chat/sentry.ts` and used through `logging.ts` helpers in most runtime code.
- Log context is normalized into semantic attributes and propagated via `AsyncLocalStorage`.
- Logs include active trace correlation when a Sentry span exists.
- Spans inherit log context and add span-specific attributes.
- Metrics are not emitted directly by default; existing policy expects them to be derived from logs/spans.

## Undefined Behavior

| Question                                     | Current Evidence                                                                  | Candidate Decision                                                | Status   |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| Direct metric approval                       | Criteria exist, approval process does not.                                        | Require future OpenSpec proposal with derivation proof.           | open     |
| Edge/runtime context propagation             | Current code is Node `AsyncLocalStorage`.                                         | Defer until Edge runtime support exists.                          | deferred |
| Instrumentation assertions in behavior tests | Tests often mock logging, but repo policy says telemetry is not product behavior. | Keep observability tests focused on observability contracts only. | open     |
| GenAI content capture safety                 | Current spans may capture serialized message attributes.                          | Keep capture limits in tracing/security specs.                    | open     |

## Migration Notes

- Keep `specs/instrumentation.md` as the entry point until this OpenSpec baseline is accepted.
- `logging`, `tracing`, and `otel-semantics` backfills should link back to this capability rather than redefining metrics policy.

## Validation

- `openspec validate backfill-instrumentation --strict` passed.
