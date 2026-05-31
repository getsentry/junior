## ADDED Requirements

### Requirement: Instrumentation Ownership

The instrumentation capability SHALL define shared observability policy across structured logs, traces, semantic attributes, and derived metrics without duplicating the detailed logging, tracing, or semantic-key capability specs.

#### Scenario: Contributor adds a new observability requirement

- **WHEN** a new requirement defines log record shape, log event naming, span naming, span attributes, or semantic-key selection
- **THEN** the requirement SHALL be placed in the narrower `logging`, `tracing`, or `otel-semantics` capability
- **AND** the `instrumentation` capability SHALL own only the cross-signal policy or routing rule

#### Scenario: Observability specs overlap

- **WHEN** two observability specs appear to own the same behavior
- **THEN** `instrumentation` SHALL identify the ownership boundary and the narrower behavior spec SHALL own the concrete implementation requirement

### Requirement: Central Observability Facade

Junior application code SHALL route structured application logs, scoped log context, exception capture, span creation, span attributes, and span status through the repository observability facade.

#### Scenario: Runtime code emits an application log

- **WHEN** chat runtime, service, tool, plugin, sandbox, Slack, or handler code emits an application log
- **THEN** it SHALL use the repo logging facade rather than direct `console.*` calls or ad hoc logger instances

#### Scenario: Runtime code creates a manual span

- **WHEN** runtime code creates a manual workflow, GenAI, tool, sandbox, or provider span
- **THEN** it SHALL use the repo span helpers or the approved Sentry wrapper boundary so context propagation and attribute normalization remain centralized

### Requirement: Cross-Signal Correlation

Junior instrumentation SHALL preserve request, conversation, workflow, user, model, and trace correlation across logs and spans whenever that context is available.

#### Scenario: Code runs inside a scoped workflow context

- **WHEN** logs or child spans are emitted inside a scoped request, turn, workflow, or model context
- **THEN** shared context attributes SHALL be attached without requiring each callsite to repeat baseline context keys

#### Scenario: Log is emitted inside an active span

- **WHEN** a structured log is emitted while an active span exists
- **THEN** the log record SHALL include trace and span correlation identifiers when the tracing backend exposes them

### Requirement: Semantic-First Instrumentation

Instrumentation attributes SHALL use OpenTelemetry semantic conventions when a suitable convention exists and SHALL use `app.*` only for repo-specific attributes without a semantic convention.

#### Scenario: New attribute is introduced

- **WHEN** a new log or span attribute is added
- **THEN** the contributor SHALL check the semantic map before creating a custom key
- **AND** any custom key SHALL be namespaced under `app.*` unless a narrower spec explicitly defines another non-semantic namespace

#### Scenario: Semantic convention is still evolving

- **WHEN** an applicable OpenTelemetry convention is in development status
- **THEN** Junior SHOULD still prefer the semantic key for interoperability and document any fallback or deliberate divergence in the semantic map

### Requirement: Metrics Derivation Default

Junior SHALL derive operational metrics from logs and spans by default instead of adding direct metric emission.

#### Scenario: Counter or latency metric can be derived

- **WHEN** an operational metric can be computed from stable log `event.name` values, log attributes, span status, or span duration
- **THEN** the implementation SHALL use derived metrics rather than adding a direct metric emitter

#### Scenario: Direct metric is proposed

- **WHEN** a direct metric is proposed because logs or spans are insufficient
- **THEN** the proposal SHALL document the missing aggregation, cardinality or retention constraint, alert latency requirement, owner, and verification path

### Requirement: Telemetry Is Usually Not Product Behavior

Product behavior tests SHALL NOT assert logs, spans, or metrics unless the changed contract is instrumentation itself or observability output is the product-visible behavior under test.

#### Scenario: Runtime behavior test is added

- **WHEN** a test verifies Slack delivery, agent output, tool behavior, auth, state, or queueing
- **THEN** it SHALL assert the user-visible or runtime-state behavior rather than incidental logs or spans

#### Scenario: Instrumentation behavior is changed

- **WHEN** a change modifies log context propagation, span attributes, trace/log correlation, semantic-key normalization, or metrics policy
- **THEN** focused observability tests SHALL verify those instrumentation contracts directly

### Requirement: Safe Instrumentation Payloads

Instrumentation SHALL obey security redaction and payload-size limits across logs, spans, and future metrics.

#### Scenario: Instrumentation includes user, prompt, tool, file, credential, or provider data

- **WHEN** a log, span, or metric would include data from user content, model prompts, tool arguments, tool results, files, credentials, authorization flows, or provider responses
- **THEN** it SHALL apply the security-policy and narrower logging/tracing capture rules before emission

#### Scenario: Signal captures large content

- **WHEN** a signal needs to include large structured content for debugging
- **THEN** the implementation SHALL prefer bounded previews, size metadata, or explicit opt-in capture over unbounded raw payloads
