## ADDED Requirements

### Requirement: Central Logging Facade

Junior application code SHALL emit structured application logs through the repository logging facade.

#### Scenario: Application code logs an event

- **WHEN** chat runtime, ingress, service, tool, plugin, sandbox, Slack, queue, or handler code emits an application log
- **THEN** it SHALL use `packages/junior/src/chat/logging.ts` APIs or approved compatibility shims
- **AND** it SHALL NOT use direct `console.*` calls for application telemetry

#### Scenario: Third-party SDK logs are bridged

- **WHEN** a supported SDK such as the Chat SDK emits logs through a Junior adapter
- **THEN** the adapter SHALL convert them into Junior structured log records with stable event names and sanitized attributes

### Requirement: Structured Log Record Shape

Every Junior application log record SHALL include a stable event name, human-readable body, severity, and flat sanitized attributes.

#### Scenario: Log record is emitted

- **WHEN** any facade log API emits a record
- **THEN** the record SHALL include `event.name` as a stable machine identifier
- **AND** it SHALL include a concise body intended for humans
- **AND** it SHALL include severity equivalent to debug, info, warn, or error

#### Scenario: Event name is supplied

- **WHEN** a caller supplies an event name
- **THEN** the facade SHALL normalize it to a snake_case identifier suitable for grouping, dashboards, and alerts

### Requirement: Semantic Attribute Normalization

Log attributes SHALL be flat, JSON-safe, semantically named, and sanitized before emission.

#### Scenario: Attribute key has an OpenTelemetry equivalent

- **WHEN** a log attribute represents HTTP, Slack messaging, GenAI, error, process, or other semantically defined data
- **THEN** the log record SHALL use the OpenTelemetry semantic key chosen by the repo semantic map

#### Scenario: Attribute has no semantic equivalent

- **WHEN** a log attribute has no suitable semantic convention
- **THEN** the key SHALL use the `app.*` namespace unless a narrower spec explicitly defines a different namespace

#### Scenario: Attribute value is unsupported or empty

- **WHEN** an attribute value is undefined, null, empty, nested, or otherwise unsupported
- **THEN** the logging facade SHALL drop or normalize it rather than emitting nested arbitrary payloads

### Requirement: Ambient Log Context

Junior SHALL support ambient log context for request, operation, workflow, Slack, user, model, and skill correlation.

#### Scenario: Context is bound around a workflow

- **WHEN** code runs inside a scoped log context
- **THEN** child log records SHALL inherit the scoped semantic attributes without repeating them at each callsite

#### Scenario: Attribute keys collide

- **WHEN** request context, operation context, and event-local attributes define the same key
- **THEN** event-local attributes SHALL take precedence over operation context
- **AND** operation context SHALL take precedence over request context

### Requirement: Trace Correlation In Logs

Log records emitted inside an active trace/span context SHALL include trace correlation fields when the tracing backend exposes them.

#### Scenario: Active span is available

- **WHEN** a log record is emitted while Sentry exposes an active span with trace and span identifiers
- **THEN** the log record SHALL include `trace_id` and `span_id`

#### Scenario: Active span is unavailable

- **WHEN** no active span or span JSON API is available
- **THEN** the logger SHALL still emit the log record without trace correlation fields
- **AND** it SHALL NOT fail logging because tracing is unavailable

### Requirement: Redaction And Bounded Payloads

The logging facade SHALL redact secrets and bound large payloads before emission to console, structured sinks, and Sentry.

#### Scenario: Secret-like value is logged

- **WHEN** a log body or attribute contains token-like values, raw Bearer credentials, secret-like env assignments, private key material, authorization headers, or provider credentials
- **THEN** the emitted log SHALL redact the sensitive value before it reaches any sink

#### Scenario: Large payload is logged

- **WHEN** a log attribute contains a large string or content payload
- **THEN** the logger SHALL truncate, preview, or summarize the value according to the logging capture policy

### Requirement: Console Rendering Is Presentation Only

Console log formatting SHALL NOT change the underlying structured log record emitted to structured sinks.

#### Scenario: Development compact format is active

- **WHEN** Junior runs in development mode without `JUNIOR_LOG_FORMAT=structured`
- **THEN** console output MAY render a compact human-oriented summary
- **AND** it MAY suppress repeated low-value fields from the console line
- **BUT** structured sinks SHALL retain the normalized attributes

#### Scenario: Structured console format is requested

- **WHEN** `JUNIOR_LOG_FORMAT=structured` is set
- **THEN** console output SHALL include the structured attribute projection rather than the compact development summary

### Requirement: Tool Lifecycle Log Noise Control

Ordinary successful tool execution SHALL be represented primarily by spans instead of duplicated start and completion info logs.

#### Scenario: Tool execution succeeds normally

- **WHEN** a tool call completes without unusual state
- **THEN** Junior SHOULD rely on the tool execution span and span attributes for success-path observability
- **AND** it SHOULD NOT emit both started and completed info logs for that ordinary success path

#### Scenario: Tool execution has unusual state

- **WHEN** a tool call fails, receives invalid input, triggers auth interruption, or enters another unusual state where a point-in-time event is useful
- **THEN** Junior MAY emit a structured warn, error, or info log with event-local attributes

### Requirement: Exception Logging

Exception logging SHALL emit a structured error log and capture the exception through Sentry when Sentry capture is available.

#### Scenario: Error is logged through exception API

- **WHEN** a caller logs an exception
- **THEN** the logging facade SHALL emit an error-level structured record with `error.type`, `exception.message`, and safe stacktrace information when available
- **AND** it SHALL return the Sentry event id when capture succeeds and an event id is available

#### Scenario: Non-Error value is logged as an exception

- **WHEN** a caller passes a non-Error value to exception logging
- **THEN** the logging facade SHALL normalize it into an Error-like value before emission and capture

### Requirement: GenAI Usage Log Helpers

Junior logging utilities SHALL normalize Pi/AI provider usage data into repo-level usage summaries and current GenAI semantic attributes.

#### Scenario: Usage appears on multiple assistant messages

- **WHEN** a turn includes usage metadata from multiple AI messages or provider records
- **THEN** usage extraction SHALL aggregate recognized token counters across sources

#### Scenario: Cache token counters are present

- **WHEN** usage contains cached input or cache-creation counters
- **THEN** the semantic usage attributes SHALL include cache counters and SHALL include them in total input token accounting according to the repo GenAI usage policy
