## Context

Junior logs are structured application events emitted through `packages/junior/src/chat/logging.ts`. The logging facade owns LogTape configuration, normalized event names, attribute sanitization, redaction, ambient context, Sentry logger forwarding, exception capture, Chat SDK bridge logs, and console formatting.

Logging is adjacent to tracing but not the same capability. Logs are point-in-time events with stable `event.name` values; traces model operation duration and parent/child relationships. The logging baseline must preserve trace correlation without owning span lifecycle.

## Prior Art

- OpenTelemetry logs define record fields including timestamp, severity, body, attributes, trace id, span id, and event name: https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OpenTelemetry trace-context logging guidance records trace and span identifiers for correlation in non-OTLP log formats: https://opentelemetry.io/docs/specs/otel/compatibility/logging_trace_context/
- LogTape supports structured logging and context-local propagation through `AsyncLocalStorage`: https://logtape.org/manual/contexts
- LogTape supports structured properties on log records: https://logtape.org/manual/struct
- Sentry JavaScript logging/tracing integrations support structured attributes and active span correlation through the SDK boundary used by Junior: https://docs.sentry.dev/platforms/javascript/guides/node/tracing/instrumentation/

## Local Evidence

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

## Behavior Extraction

- `log.debug/info/warn/error/exception` is the primary structured logging API.
- Compatibility shims `logInfo`, `logWarn`, `logError`, `logException`, `withContext`, and `withSpan` remain supported for migrated callsites.
- Log records normalize event names to `snake_case`, include `event.name`, keep a human-readable body, and sanitize attributes.
- `LogContext` maps repo concepts to semantic attributes such as `gen_ai.conversation.id`, `messaging.message.conversation_id`, `messaging.destination.name`, `enduser.id`, `gen_ai.request.model`, `http.request.method`, and `url.path`.
- Context merge precedence is event attributes over operation context over request context.
- Active Sentry span ids are attached to logs when available.
- Secret redaction handles common token patterns, Bearer tokens, secret-like env assignments, private key blocks, and value truncation.
- Console rendering may be compact in development while retaining structured records for sinks; `JUNIOR_LOG_FORMAT=structured` forces full projection.
- Production suppresses info logs to Sentry while console behavior remains environment-specific.
- Chat SDK logs are bridged into structured `chat_sdk_*` event names.
- Ordinary successful tool execution should be represented by spans rather than start/completed info log pairs.

## Open Questions / Undefined Behavior

| Question                                                                         | Current Evidence                                          | Candidate Decision                                                                        | Status   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| Should direct `console.*` be mechanically blocked?                               | Spec says centralized API; no broad lint rule found.      | Add static enforcement only if direct console usage becomes recurring.                    | open     |
| Should every event name be enumerated in a registry?                             | Current convention is format-based, not registry-based.   | Avoid registry until dashboard/alert ownership needs it.                                  | open     |
| What is the exact maximum payload size per attribute?                            | Code uses truncation constants; spec says bounded.        | Keep exact limits implementation-owned unless external sink constraints require freezing. | deferred |
| Should redaction include provider-specific token formats beyond current regexes? | Current regexes cover common patterns, not all providers. | Add patterns with tests when adding providers or observing misses.                        | open     |
| Should test sinks be public API?                                                 | `registerLogRecordSink` exists for tests.                 | Keep as test/support surface, not product API.                                            | open     |

## Decisions

### Decision: Logging owns events, not operation duration

Log records are stable point-in-time events grouped by `event.name`. Operation timing, parent-child relationships, and span status belong to tracing.

### Decision: Ambient context is the default for baseline keys

Request, conversation, user, channel, run, and model context should be bound once and inherited. Per-call attributes should describe the local event.

### Decision: Console format is presentation only

Compact development output may suppress repeated attributes, but structured records and sinks must retain normalized attributes.

## Verification Strategy

- Unit tests for record formatting, development versus structured console rendering, redaction, context inheritance, trace correlation, usage summary mapping, and compatibility shims.
- Static review or targeted tests for direct logging facade usage when migrating callsites.
- Product behavior tests should not assert logs unless logging behavior is the contract.
