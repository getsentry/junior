## ADDED Requirements

### Requirement: Lifecycle-Oriented Span Model

Junior tracing SHALL instrument meaningful workflow, AI, tool, MCP, and sandbox lifecycle boundaries rather than every internal helper call.

#### Scenario: New operation is instrumented

- **WHEN** a contributor adds tracing for a runtime operation
- **THEN** the span SHOULD represent a meaningful unit of work with distinct latency, failure, or operational value
- **AND** it SHOULD NOT add low-value spans for pure helper functions without independent operational meaning

#### Scenario: Span is named

- **WHEN** a span is created
- **THEN** its name SHALL be low-cardinality and its `op` SHALL use the repo's dotted operation category convention

### Requirement: Span Context Propagation

Callback-scoped spans SHALL inherit active log/workflow context and add span-specific attributes without dropping baseline correlation.

#### Scenario: Child span is created inside workflow context

- **WHEN** a child span is created inside a scoped request, conversation, run, user, channel, or model context
- **THEN** the span SHALL include inherited correlation attributes where available
- **AND** span-specific attributes SHALL be allowed to add or override local operation details

#### Scenario: Active span attributes are updated

- **WHEN** runtime code sets attributes or status on the active span
- **THEN** the helper SHALL no-op safely if no active span or compatible span API exists

### Requirement: GenAI Chat Spans

Junior SHALL trace direct and agent-loop model calls as `gen_ai.chat` spans with semantic GenAI attributes.

#### Scenario: Direct chat completion runs

- **WHEN** Junior performs a direct model completion outside the Pi agent loop
- **THEN** it SHALL create a `gen_ai.chat` span that includes provider, operation name, request model, safe input messages, safe system instructions when present, and post-call output, finish reason, and usage attributes when available

#### Scenario: Pi agent loop performs a model call

- **WHEN** Pi agent execution invokes the configured stream function for an LLM call
- **THEN** Junior SHALL create one `gen_ai.chat` span for that model call
- **AND** the span SHALL remain open until the returned stream result settles

#### Scenario: Streaming model call fails

- **WHEN** the stream function throws before returning a stream or the returned stream rejects
- **THEN** the chat span SHALL be ended exactly once and marked with error status

### Requirement: GenAI Agent And Tool Span Hierarchy

Agent execution and tool calls SHALL use GenAI operation spans that can be correlated with their child chat/tool work.

#### Scenario: Agent loop is traced

- **WHEN** a `gen_ai.invoke_agent` span represents an agent loop
- **THEN** model calls issued during that loop SHALL appear as `gen_ai.chat` child spans when the tracing backend supports parent/child linkage

#### Scenario: Tool call executes

- **WHEN** a Pi tool call executes
- **THEN** Junior SHALL create a `gen_ai.execute_tool` span with tool name, operation name, provider name, tool description when available, tool call id when available, and safe tool-call arguments when captured
- **AND** it SHALL add safe tool-call result attributes after execution when captured

### Requirement: MCP Tool Trace Attributes

MCP tool execution spans SHALL include MCP and JSON-RPC semantic attributes when those values are available and safe.

#### Scenario: MCP tool call is dispatched

- **WHEN** Junior calls an MCP tool
- **THEN** the active tool span SHALL include `mcp.method.name` with `tools/call`
- **AND** it SHOULD include additional MCP, JSON-RPC, network, server, protocol, and tool attributes defined by the repo semantic map when available

#### Scenario: MCP tool returns an expected tool error

- **WHEN** an MCP tool returns a structured tool error
- **THEN** the active span SHALL include low-cardinality error attributes and safe exception message details
- **AND** the error log and span attributes SHALL use compatible semantic keys

### Requirement: Sandbox Lifecycle Spans

Sandbox acquisition, reuse, creation, dependency snapshot handling, skill sync, command execution, keepalive, and disposal SHALL be visible through lifecycle spans.

#### Scenario: Sandbox is acquired

- **WHEN** a sandbox-backed executor needs a sandbox
- **THEN** Junior SHALL create a `sandbox.acquire` span and child spans for material lifecycle work such as reuse probing, retrieving an id hint, creating a sandbox, resolving/building snapshots, syncing skills, or updating network policy

#### Scenario: Bash command runs in the sandbox

- **WHEN** Junior executes a sandbox bash command
- **THEN** it SHALL create a process execution span with executable name, exit code, stdout/stderr byte counts, and error status/type when the command fails or throws

#### Scenario: Sandbox is stopped

- **WHEN** Junior disposes a live sandbox session
- **THEN** it SHALL create a sandbox stop span for the blocking stop operation

### Requirement: Span Error And Status Semantics

Spans SHALL reflect terminal operation failures through status and safe error attributes.

#### Scenario: Operation throws

- **WHEN** a traced operation throws or rejects with a terminal failure
- **THEN** the span SHALL be marked as failed when the tracing backend supports status
- **AND** safe `error.type` or exception attributes SHALL be recorded when available

#### Scenario: Best-effort operation fails

- **WHEN** a best-effort operation such as keepalive extension fails and the workflow should continue
- **THEN** the failure MAY be swallowed by the workflow
- **AND** tracing/logging SHOULD preserve enough safe context for operators when practical

### Requirement: Trace Payload Safety

Span attributes SHALL use bounded, low-cardinality, safe payloads and SHALL NOT include raw secrets or unbounded file/content payloads.

#### Scenario: Span captures prompt, tool, command, file, or provider content

- **WHEN** a span captures content-like data
- **THEN** the capture SHALL follow the security, logging, and semantic-key policies for redaction, truncation, and explicit content capture

#### Scenario: Command execution is traced

- **WHEN** a sandbox process span is emitted
- **THEN** the span SHALL NOT include raw command text by default
- **AND** it SHALL prefer executable, exit code, byte counts, status, and bounded metadata

### Requirement: Trace-Derived Metrics

Tracing SHALL provide stable durations, statuses, and attributes that can be used for derived operational metrics.

#### Scenario: Operational metric needs latency or failure counts

- **WHEN** an operational metric can be derived from span duration, span status, span name/op, and stable attributes
- **THEN** the tracing signal SHALL be preferred over adding a direct metric emitter
