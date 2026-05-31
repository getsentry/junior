## ADDED Requirements

### Requirement: Tool definition registration

Junior SHALL register agent tools from local `ToolDefinition` metadata into Pi `AgentTool` objects for each turn.

#### Scenario: Tool definition has schema and description

- **WHEN** a tool is registered for an agent turn
- **THEN** Junior SHALL expose its name, description, and input schema to Pi

#### Scenario: Tool definition has argument preparation

- **WHEN** a tool defines `prepareArguments`
- **THEN** Junior SHALL forward that preparation hook to Pi unchanged

#### Scenario: Tool definition has execution mode

- **WHEN** a tool defines a Pi execution mode
- **THEN** Junior SHALL forward that execution mode to Pi unchanged

#### Scenario: Tool definition has no execute function

- **WHEN** Pi calls a registered tool that intentionally has no local execute function
- **THEN** Junior SHALL return a successful no-op tool result rather than throwing an internal error

### Requirement: Turn-scoped tool assembly

Junior SHALL assemble tool availability from the current turn context.

#### Scenario: Core tools are always available

- **WHEN** a normal agent turn starts
- **THEN** Junior SHALL register core tools such as skill loading, progress reporting, time, sandbox file/shell tools, web tools, and readable Slack context tools

#### Scenario: Channel capability is absent

- **WHEN** the active channel context cannot support a Slack side-effect class such as channel posts, reactions, or canvases
- **THEN** Junior SHALL omit those tools from the available tool set for the turn

#### Scenario: MCP manager is absent

- **WHEN** no MCP tool manager is available for the turn
- **THEN** Junior SHALL omit MCP search and call tools

#### Scenario: Trusted plugin tool conflicts with core tool

- **WHEN** a trusted plugin registers a tool name already used by a core tool
- **THEN** Junior SHALL fail registration rather than silently replacing either tool

### Requirement: Tool hook and progress handling

Junior SHALL run shared execution hooks around tool calls without changing Pi tool semantics.

#### Scenario: Progress tool is called

- **WHEN** the model calls the progress-reporting tool with a valid progress message
- **THEN** Junior SHALL update assistant status through the runtime progress surface
- **AND** Junior SHALL still return a normal tool result to Pi

#### Scenario: Non-progress tool is called

- **WHEN** the model calls any other tool
- **THEN** Junior SHALL NOT synthesize assistant status from the tool call itself

#### Scenario: Plugin before-tool hook rewrites input

- **WHEN** a plugin hook returns modified tool input before execution
- **THEN** Junior SHALL execute the tool with the modified input and report that input to turn-level tool-call observers

### Requirement: Sandbox execution routing

Junior SHALL route sandbox-owned tools through the sandbox executor when available.

#### Scenario: Sandbox executor can execute the tool

- **WHEN** a sandbox executor reports that it can execute a tool name
- **THEN** Junior SHALL normalize the tool input into the sandbox executor shape and call the sandbox executor instead of the host tool implementation

#### Scenario: Sandbox executor cannot execute the tool

- **WHEN** no sandbox executor is available for a tool name
- **THEN** Junior SHALL call the tool definition's host execute function

#### Scenario: Sandbox executor returns envelope

- **WHEN** a sandbox executor returns a result envelope
- **THEN** Junior SHALL unwrap the envelope before returning the normalized tool result to Pi

### Requirement: Successful result normalization

Junior SHALL normalize every successful tool execution into Pi-compatible content and structured details.

#### Scenario: Tool returns structured content and details

- **WHEN** a tool returns content parts and details in the supported structured shape
- **THEN** Junior SHALL pass that structured result through unchanged

#### Scenario: Tool returns a plain string

- **WHEN** a tool returns a string
- **THEN** Junior SHALL return a single text content part containing that string and preserve the string as details

#### Scenario: Tool returns a JSON-serializable value

- **WHEN** a tool returns an object, array, boolean, number, or null that is not already structured
- **THEN** Junior SHALL serialize the value into a text content part and preserve the original value as details

#### Scenario: Tool returns image content

- **WHEN** a tool returns structured image content with base64 data and media type
- **THEN** Junior SHALL preserve the image content part for Pi

### Requirement: Expected tool failure semantics

Junior SHALL surface model-repairable tool failures as expected thrown tool errors, not successful sentinel payloads.

#### Scenario: Tool input is invalid or missing required context

- **WHEN** a tool cannot execute because model-provided input is invalid, target context is missing, or requested state is unsupported but repairable
- **THEN** the tool SHALL throw `ToolInputError` or an equivalent expected tool-input error
- **AND** Junior SHALL allow Pi to record the failure as a tool-result error so the model can repair the call

#### Scenario: MCP tool returns an error result

- **WHEN** an MCP tool returns an error result
- **THEN** Junior SHALL convert it into an expected MCP tool error rather than a successful tool result

#### Scenario: Plugin tool reports input error

- **WHEN** a plugin tool throws a plugin input error
- **THEN** Junior SHALL classify it as an expected tool-input failure

#### Scenario: Tool returns successful sentinel failure

- **WHEN** a model-facing tool operation fails in a way the model can repair
- **THEN** Junior SHALL NOT return a successful `{ ok: false }` style result as the final tool output

#### Scenario: Tool returns negative domain data

- **WHEN** a model-facing tool successfully answers a query and the answer is negative, empty, or otherwise unsuccessful as domain data
- **THEN** Junior MAY return structured data that represents that domain result
- **AND** Junior SHALL NOT use that successful result shape for invalid input, missing required context, unsupported repairable state, or failed execution

#### Scenario: Nested advisor run is unavailable

- **WHEN** the `advisor` tool cannot produce guidance because the nested advisor runtime is unavailable, lacks a parent conversation id, receives invalid advisor arguments, or fails internally
- **THEN** Junior MAY return its specified non-fatal `ok:false` advisor result instead of raising a model-repairable tool error
- **AND** this exception SHALL remain scoped to the advisor tool's nested-agent advisory contract

### Requirement: Unexpected tool failure handling

Junior SHALL distinguish expected model-repairable failures from unexpected system failures.

#### Scenario: Unexpected system error occurs

- **WHEN** tool execution throws an unexpected system error
- **THEN** Junior SHALL mark the tool span as failed, log/report the exception, and rethrow to Pi

#### Scenario: Expected tool error occurs

- **WHEN** tool execution throws `ToolInputError`, expected MCP tool error, or plugin input error
- **THEN** Junior SHALL mark the tool span with an expected error type
- **AND** Junior SHALL NOT report it as an unexpected exception

#### Scenario: Slack action error occurs

- **WHEN** a Slack action throws a Slack action error
- **THEN** Junior SHALL preserve Slack error code attributes for diagnostics while still applying expected versus unexpected failure classification from the tool family contract

### Requirement: Authorization interrupt propagation

Junior SHALL keep authorization pauses out of ordinary model-repairable tool failure handling.

#### Scenario: Tool raises authorization pause

- **WHEN** a tool detects that provider authorization is required and starts an auth pause
- **THEN** Junior SHALL propagate the authorization pause to the runtime/session layer rather than converting it into a normal tool error

#### Scenario: Auth flow is disabled

- **WHEN** a tool needs authorization but the authorization flow is disabled
- **THEN** Junior SHALL propagate the disabled-auth error to the runtime/session layer

#### Scenario: MCP auth pause already parked the turn

- **WHEN** MCP auth handling has requested a pause and the turn is being parked
- **THEN** Junior MAY return a placeholder authorization-pending tool result only to avoid surfacing a spurious model-visible tool failure

### Requirement: Turn-scoped side-effect idempotency

Junior SHALL support deterministic turn-local idempotency for side-effect tools.

#### Scenario: Operation key is built from equivalent inputs

- **WHEN** two tool inputs contain the same JSON-like values with different object key order
- **THEN** Junior SHALL build the same operation key for both inputs

#### Scenario: Side-effect tool repeats identical operation in one turn

- **WHEN** a side-effect tool uses the same operation key more than once in a turn
- **THEN** Junior SHALL allow the tool to reuse the cached result instead of repeating the external side effect

#### Scenario: New turn starts

- **WHEN** a later turn starts
- **THEN** Junior SHALL start with fresh turn-scoped idempotency state unless a tool-family spec defines a stronger durable guarantee

### Requirement: Tool-execution verification taxonomy

Tool-execution verification SHALL separate shared wrapper mechanics from tool-family behavior and model-facing tool-use quality.

#### Scenario: Shared execution mechanics are verified

- **WHEN** verifying result normalization, sandbox input shaping, error classification, tool metadata forwarding, progress routing, or operation-key generation
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Side-effect idempotency and dynamic tool wiring are verified

- **WHEN** verifying repeated side-effect dedupe, dynamic MCP tool exposure, or plugin/core tool conflicts
- **THEN** the primary coverage SHALL be integration tests when external/runtime wiring is involved

#### Scenario: Model repair after tool error is verified

- **WHEN** verifying that the model observes an expected tool-result error and corrects its next tool call or final answer
- **THEN** the primary coverage SHALL be evals or Pi integration tests, depending on whether natural-language behavior is part of the contract
