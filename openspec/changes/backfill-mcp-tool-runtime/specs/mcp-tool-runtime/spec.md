## ADDED Requirements

### Requirement: Configured MCP provider catalog

Junior SHALL maintain a turn-scoped catalog of plugin providers that declare MCP configuration.

#### Scenario: Provider has no MCP declaration

- **WHEN** a plugin does not declare MCP configuration
- **THEN** Junior SHALL exclude that plugin from the MCP provider catalog

#### Scenario: Catalog is requested before activation

- **WHEN** the runtime or model asks for configured MCP providers
- **THEN** Junior SHALL return provider names, descriptions, and active state without connecting to remote MCP servers

#### Scenario: Active providers are listed

- **WHEN** MCP providers are active
- **THEN** Junior SHALL return active provider names in deterministic order

### Requirement: MCP provider activation

Junior SHALL activate configured MCP providers lazily when a skill, provider-scoped search, or exact MCP tool call requires them.

#### Scenario: Skill has no plugin provider

- **WHEN** a skill has no `pluginProvider`
- **THEN** MCP activation SHALL be skipped

#### Scenario: Skill has configured plugin provider

- **WHEN** a loaded skill references a configured MCP provider
- **THEN** Junior SHALL connect to that provider, list its tools, apply manifest allowlists, and make the surviving tools active for the turn

#### Scenario: Provider-scoped search names inactive configured provider

- **WHEN** `searchMcpTools` is called with a configured provider that is not active
- **THEN** Junior SHALL attempt to activate that provider before returning tool descriptors

#### Scenario: Exact MCP tool call names inactive configured provider

- **WHEN** `callMcpTool` receives a canonical tool name for a configured inactive provider
- **THEN** Junior SHALL attempt to activate that provider before resolving the exact tool

#### Scenario: Provider is already active

- **WHEN** activation is requested for an already active provider
- **THEN** Junior SHALL leave the existing client and tool catalog in place

#### Scenario: Provider is pending authorization

- **WHEN** activation is requested for a provider already parked for authorization
- **THEN** Junior SHALL not reconnect or repeat the authorization request in the same turn slice

#### Scenario: Allowlisted tool is missing

- **WHEN** a plugin manifest allowlist names an MCP tool that discovery did not return
- **THEN** Junior SHALL fail provider activation with an explicit missing-tool error

### Requirement: MCP tool descriptor normalization

Junior SHALL normalize MCP tool definitions into collision-safe model-facing descriptors.

#### Scenario: Tool is discovered

- **WHEN** MCP `tools/list` returns a tool definition
- **THEN** Junior SHALL expose a canonical model-facing name in the form `mcp__<provider>__<rawToolName>`
- **AND** Junior SHALL retain the raw MCP tool name for `tools/call`

#### Scenario: Tool metadata is available

- **WHEN** a discovered tool has title, description, input schema, output schema, or annotations
- **THEN** Junior SHALL expose those fields in the active tool descriptor when they are object-shaped and non-empty where applicable

#### Scenario: Multiple providers expose same raw tool name

- **WHEN** two active providers expose the same raw MCP tool name
- **THEN** Junior SHALL keep their model-facing tool names distinct by provider prefix

#### Scenario: Descriptor is shown to the model

- **WHEN** a descriptor is returned by `searchMcpTools`
- **THEN** Junior SHALL include the exact `callMcpTool` shape the model should use, including canonical `tool_name` and nested `arguments`

### Requirement: Progressive MCP tool search

Junior SHALL expose MCP providers and active MCP tools through a progressive search tool before dispatch.

#### Scenario: Search omits provider

- **WHEN** `searchMcpTools` is called without a provider
- **THEN** Junior SHALL search currently active MCP tools
- **AND** Junior SHALL return matching configured providers without connecting inactive providers

#### Scenario: Search includes provider

- **WHEN** `searchMcpTools` is called with a configured provider
- **THEN** Junior SHALL search only that provider's active tools after any required activation
- **AND** Junior SHALL omit the configured-provider list from the result

#### Scenario: Query is omitted

- **WHEN** `searchMcpTools` is called without a query
- **THEN** Junior SHALL return deterministically ordered tool descriptors up to the requested limit

#### Scenario: Query is supplied

- **WHEN** `searchMcpTools` is called with search terms
- **THEN** Junior SHALL match against tool names, raw names, provider names, descriptions, schemas, and annotations

#### Scenario: Result limit is supplied

- **WHEN** `max_results` is supplied
- **THEN** Junior SHALL cap returned tool and provider matches to the configured maximum

### Requirement: Exact MCP tool dispatch

Junior SHALL dispatch MCP calls only through `callMcpTool` using exact canonical names and nested arguments.

#### Scenario: Active tool is called

- **WHEN** `callMcpTool` receives the exact canonical `tool_name` of an active MCP tool
- **THEN** Junior SHALL call the provider's raw MCP tool name with the nested `arguments` object

#### Scenario: Arguments are omitted

- **WHEN** `callMcpTool` receives no `arguments` field
- **THEN** Junior SHALL call the MCP tool with an empty argument object

#### Scenario: Top-level arguments are supplied

- **WHEN** model-supplied MCP tool arguments appear as extra top-level `callMcpTool` fields
- **THEN** Junior SHALL reject the call instead of silently dropping or merging those fields

#### Scenario: Nested arguments are not an object

- **WHEN** `arguments` is present but is not an object
- **THEN** Junior SHALL reject the call before contacting the provider

#### Scenario: Tool name is not active after activation attempt

- **WHEN** no active MCP tool exactly matches the requested canonical `tool_name`
- **THEN** Junior SHALL fail with a repairable inactive-tool error

### Requirement: MCP result conversion

Junior SHALL convert MCP tool results into Pi-compatible tool content while preserving raw diagnostics.

#### Scenario: Text content is returned

- **WHEN** an MCP result contains text content
- **THEN** Junior SHALL pass the text content through to Pi

#### Scenario: Image content is returned

- **WHEN** an MCP result contains image content
- **THEN** Junior SHALL pass image data and media type through to Pi

#### Scenario: Audio content is returned

- **WHEN** an MCP result contains audio content
- **THEN** Junior SHALL summarize the audio media type and encoded size as text

#### Scenario: Resource link is returned

- **WHEN** an MCP result contains a resource link
- **THEN** Junior SHALL expose the URI as text

#### Scenario: Embedded resource is returned

- **WHEN** an MCP result contains an embedded text resource
- **THEN** Junior SHALL expose the resource text

#### Scenario: Embedded binary resource is returned

- **WHEN** an MCP result contains an embedded binary resource
- **THEN** Junior SHALL summarize the URI, media type when available, and encoded size as text

#### Scenario: Structured content exists without content parts

- **WHEN** an MCP result has `structuredContent` and no convertible content parts
- **THEN** Junior SHALL serialize structured content as text for Pi

#### Scenario: Result has no content

- **WHEN** an MCP result has no convertible content or structured content
- **THEN** Junior SHALL return a minimal success text result

#### Scenario: Raw result is recorded

- **WHEN** an MCP tool call completes
- **THEN** Junior SHALL include provider, raw tool name, and raw MCP result in tool details

### Requirement: MCP errors and authorization interrupts

Junior SHALL distinguish MCP tool execution errors, protocol/runtime errors, and authorization interrupts.

#### Scenario: MCP result is an execution error

- **WHEN** an MCP `tools/call` result has `isError: true`
- **THEN** Junior SHALL raise an expected MCP tool error using text or structured result content as the model-readable message

#### Scenario: MCP client receives authorization challenge

- **WHEN** the MCP client receives an authorization challenge during connect, discovery, or invocation
- **THEN** Junior SHALL surface `McpAuthorizationRequiredError` to the MCP tool manager

#### Scenario: Authorization handler parks the turn

- **WHEN** the MCP authorization handler reports the challenge was handled by parking the turn
- **THEN** Junior SHALL mark the provider authorization-pending, remove active tools for that provider, remove its cached client, and avoid exposing a spurious model repair failure

#### Scenario: Authorization handler does not park

- **WHEN** no authorization handler exists or the handler does not accept the challenge
- **THEN** Junior SHALL propagate the authorization error

#### Scenario: Session is missing on server

- **WHEN** the streamable HTTP transport reports a missing saved session
- **THEN** Junior SHALL clear the stored MCP server session ID, dispose the client, and retry the operation once

#### Scenario: MCP manager closes

- **WHEN** the MCP tool manager is closed
- **THEN** Junior SHALL close every cached client, clear active tools, clear active providers, clear authorization-pending providers, and surface the first close error after cleanup

### Requirement: MCP-tool-runtime verification taxonomy

MCP-tool-runtime verification SHALL separate deterministic local contracts, runtime integration, auth-resume behavior, and model-facing tool use.

#### Scenario: Local MCP logic is verified

- **WHEN** verifying provider catalogs, activation, allowlist filtering, descriptor naming, search results, dispatcher validation, result conversion, session recovery, or close cleanup
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Runtime bridge is verified

- **WHEN** verifying Pi can progress through skill load, provider search, and exact MCP dispatch with only stable bridge tools
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Authorization resume is verified

- **WHEN** verifying MCP authorization pause and resume
- **THEN** the primary coverage SHALL include Slack/runtime integration tests and auth-focused evals

#### Scenario: Model-facing discovery behavior is verified

- **WHEN** verifying that the model searches for MCP tools, copies the disclosed call shape, and continues after auth
- **THEN** the primary coverage SHALL be evals owned with `skill-runtime`, `agent-prompt`, and auth specs
