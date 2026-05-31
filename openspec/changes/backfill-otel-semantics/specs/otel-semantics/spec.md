## ADDED Requirements

### Requirement: Semantic Map Ownership

The otel-semantics capability SHALL be the naming authority for attributes used by Junior logs and spans.

#### Scenario: Logging or tracing needs a new attribute

- **WHEN** a contributor adds a log or span attribute
- **THEN** they SHALL choose the key using the semantic map
- **AND** logging/tracing specs SHALL own when the key is emitted, not the key's name

#### Scenario: Attribute ownership overlaps

- **WHEN** logging, tracing, or another capability repeats key-selection rules
- **THEN** the semantic map SHALL remain the authoritative place for canonical key names and alias migration

### Requirement: OpenTelemetry Semantic Keys First

Junior SHALL use OpenTelemetry semantic attribute keys when a suitable convention exists.

#### Scenario: Attribute has a semantic convention

- **WHEN** an attribute represents HTTP, URL, user agent, messaging, GenAI, MCP, JSON-RPC, network, server, process, error, exception, service, or deployment data with an applicable OpenTelemetry convention
- **THEN** Junior SHALL use the selected OpenTelemetry semantic key

#### Scenario: Convention is development status

- **WHEN** an applicable semantic convention is still in development status
- **THEN** Junior SHOULD prefer the semantic key for interoperability
- **AND** any fallback or deliberate divergence SHALL be documented in the semantic map

### Requirement: Custom Attribute Namespace

Junior-specific attributes without suitable semantic conventions SHALL use the `app.*` namespace.

#### Scenario: Repo-specific attribute is added

- **WHEN** an attribute describes Junior-specific workflow, Slack behavior, sandbox state, plugin state, skill state, configuration, files, messages, credentials, compaction, routing, web search, or AI runtime decisions without a semantic key
- **THEN** the key SHALL use a coherent `app.<domain>.*` namespace

#### Scenario: Non-semantic raw key reaches logging normalization

- **WHEN** a caller passes a non-semantic key that is not a known legacy alias
- **THEN** the logging facade SHALL normalize it to `app.<snake_case_key>`
- **AND** it SHALL use a generic `app.attribute` fallback only when no meaningful key can be derived

### Requirement: Core Context Attribute Map

Junior SHALL map common runtime context fields to canonical semantic or app attributes.

#### Scenario: Slack conversation context is available

- **WHEN** Slack platform, channel, thread, message, or user context is logged or traced
- **THEN** Junior SHALL use `messaging.system`, `messaging.destination.name`, `messaging.message.conversation_id`, `messaging.message.id`, and `enduser.id` where applicable

#### Scenario: AI workflow context is available

- **WHEN** conversation, agent, model, run, actor, or skill context is logged or traced
- **THEN** Junior SHALL use `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.request.model`, `app.run.id`, `app.actor.*`, and `app.skill.name` according to the semantic map

#### Scenario: HTTP request context is available

- **WHEN** HTTP method, path, full URL, response status, or user agent context is safe and available
- **THEN** Junior SHALL use `http.request.method`, `url.path`, `url.full`, `http.response.status_code`, and `user_agent.original`

### Requirement: GenAI Semantic Attributes

Junior SHALL use current GenAI semantic keys for model, agent, chat, tool, message, finish reason, and usage data.

#### Scenario: Model call is traced

- **WHEN** Junior records a GenAI chat or agent span/log attribute
- **THEN** it SHALL use keys such as `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, and `gen_ai.response.finish_reasons` according to capture policy

#### Scenario: Tool call is traced

- **WHEN** Junior records tool execution attributes
- **THEN** it SHALL use `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result` when those values are available and safe

#### Scenario: Usage counters are available

- **WHEN** GenAI usage includes input, output, cache-read, or cache-creation token counters
- **THEN** Junior SHALL emit `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, and `gen_ai.usage.cache_creation.input_tokens` as applicable
- **AND** cache-read and cache-creation input tokens SHALL be included in the semantic input token total according to repo usage policy

### Requirement: MCP Semantic Attributes

Junior SHALL use MCP, JSON-RPC, network, and server semantic attributes for MCP tool calls when available.

#### Scenario: MCP tool call is recorded

- **WHEN** an MCP tool call is traced or logged
- **THEN** Junior SHALL use `mcp.method.name`, `mcp.protocol.version`, `mcp.session.id`, `jsonrpc.request.id`, `rpc.response.status_code`, `network.protocol.name`, `network.protocol.version`, `network.transport`, `server.address`, and `server.port` where applicable and safe

#### Scenario: MCP attribute is unavailable

- **WHEN** an MCP transport or client does not expose a semantic value
- **THEN** Junior SHALL omit that attribute rather than inventing an unstable custom substitute

### Requirement: Process And Sandbox Custom Attributes

Junior SHALL use process semantic attributes for generic process execution data and `app.sandbox.*` for sandbox-specific state without semantic equivalents.

#### Scenario: Sandbox command execution is traced

- **WHEN** a sandbox command span records process execution data
- **THEN** it SHALL use `process.executable.name`, `process.exit.code`, and `error.type` where applicable
- **AND** it SHALL use `app.sandbox.*` for sandbox-specific byte counts, timeout, runtime, snapshot, sync, reuse, egress, and recovery attributes without semantic equivalents

#### Scenario: Sandbox dependency snapshot data is recorded

- **WHEN** snapshot cache, dependency profile, install, rebuild, or capture data is recorded
- **THEN** the attributes SHALL use the `app.sandbox.snapshot.*` namespace unless a semantic convention is adopted for that data

### Requirement: Error And Exception Attributes

Junior SHALL use stable low-cardinality error keys and safe exception detail keys.

#### Scenario: Error type is known

- **WHEN** a log or span records a failure category
- **THEN** it SHALL use `error.type` for a low-cardinality error class or category

#### Scenario: Exception detail is recorded

- **WHEN** a log or span records an exception message or stacktrace
- **THEN** it SHALL use `exception.message` and `exception.stacktrace`
- **AND** those values SHALL be subject to security redaction and payload bounds

### Requirement: Legacy Attribute Normalization

Junior SHALL preserve compatibility for known legacy attribute keys by normalizing them to current semantic or app keys at the logging facade boundary.

#### Scenario: Legacy GenAI key is used

- **WHEN** a caller passes legacy keys such as `gen_ai.system`, `gen_ai.request.messages`, `gen_ai.response.text`, or `finishReason`
- **THEN** the logging facade SHALL normalize them to the current GenAI semantic keys

#### Scenario: Legacy messaging or app key is used

- **WHEN** a caller passes known legacy keys such as `messaging.conversation.id`, `attempt`, `skillDir`, or output summary aliases
- **THEN** the logging facade SHALL normalize them to the current semantic or `app.*` key defined by the semantic map

### Requirement: Safe Header Attribute Expansion

HTTP or provider header attributes SHALL be added only when they are safe, bounded, and useful.

#### Scenario: Header attribute is proposed

- **WHEN** a contributor proposes recording a request or response header
- **THEN** they SHALL verify it is not secret-bearing or high-cardinality before adding it
- **AND** they SHALL use the current semantic header convention or a documented safe custom key
