# Logging Backfill Worksheet

## Canonical Spec

- New spec: `logging`
- Existing source: `specs/logging.md`

## Local Artifacts Reviewed

- `specs/logging.md`
- `specs/instrumentation.md`
- `specs/tracing.md`
- `specs/otel-semantics.md`
- `specs/security-policy.md`
- `packages/junior/src/chat/logging.ts`
- `packages/junior/src/chat/sentry.ts`
- `packages/junior/src/chat/plugins/logging.ts`
- `packages/junior/tests/unit/logging/console-format.test.ts`
- `packages/junior/tests/unit/logging/with-span.test.ts`
- `packages/junior/tests/unit/logging/extract-gen-ai-usage-summary.test.ts`
- `packages/junior/tests/unit/tools/tool-error-handler.test.ts`
- `packages/junior/tests/unit/tools/execution/tool-error-handler.test.ts`

## External Sources

- OpenTelemetry logs data model: https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OpenTelemetry trace context in logs: https://opentelemetry.io/docs/specs/otel/compatibility/logging_trace_context/
- LogTape contexts: https://logtape.org/manual/contexts
- LogTape structured logging: https://logtape.org/manual/struct
- Sentry Node tracing instrumentation: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/

## Current Behavior Summary

- One logging facade owns normalized structured records.
- Event names are stable snake_case identifiers.
- Log context maps domain fields to semantic attributes and propagates through `AsyncLocalStorage`.
- Active span correlation is added when Sentry exposes trace/span ids.
- Attributes are flat, sanitized, redacted, truncated, and normalized from legacy names where supported.
- Console format is compact in development unless structured output is requested.
- Exception logging emits an error record and captures to Sentry when available.

## Undefined Behavior

| Question                             | Current Evidence              | Candidate Decision                                     | Status   |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------ | -------- |
| Direct console enforcement           | Policy exists, no lint guard. | Add only if violations recur.                          | open     |
| Event-name registry                  | Format convention exists.     | Defer registry until dashboards/alerts need ownership. | deferred |
| Exact truncation size                | Code has constants.           | Keep implementation detail.                            | deferred |
| Provider-specific redaction patterns | Generic regexes exist.        | Add pattern tests with new providers.                  | open     |

## Migration Notes

- Preserve compatibility shims while callsites remain migrated gradually.
- On acceptance, `specs/logging.md` can become rationale plus link to OpenSpec requirements.

## Validation

- `openspec validate backfill-logging --strict` passed.
