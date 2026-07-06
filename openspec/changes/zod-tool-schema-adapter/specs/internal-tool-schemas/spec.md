# Internal Tool Schemas

## ADDED Requirements

### Requirement: Zod-Authored Junior Tools

Junior-owned agent tools SHALL support an internal `zodTool(...)` authoring
helper that accepts a Zod input schema and infers the executor input type from
that schema.

#### Scenario: Parsed executor input

- **WHEN** a Junior-owned tool is authored with `zodTool(...)`
- **AND** Pi supplies model-generated arguments for that tool
- **THEN** the tool's executor receives the Zod-parsed output type
- **AND** executor code does not need ad hoc object-shape checks for fields
  already owned by the input schema.

### Requirement: Pi-Compatible Model Schema

Junior-owned Zod tool schemas SHALL be converted to JSON Schema-compatible tool
parameters before they are handed to Pi.

#### Scenario: Model-facing parameters

- **WHEN** `createAgentTools(...)` exposes a Zod-authored tool to Pi
- **THEN** the Pi tool `parameters` value is a JSON Schema-compatible object
- **AND** the code does not claim the generated JSON Schema is a real TypeBox
  schema except at the narrow Pi type adapter boundary.

### Requirement: Model-Repairable Parse Failures

Zod input parse failures from Junior-owned tools SHALL become expected tool
input failures.

#### Scenario: Invalid model arguments

- **WHEN** the model calls a Zod-authored Junior tool with invalid arguments
- **THEN** the parse failure is converted to `ToolInputError`
- **AND** Pi records a tool result with `isError=true`
- **AND** the error message is concise enough for the model to repair the tool
  call.

### Requirement: Output Validation Is Runtime Contract Validation

If a Junior-owned tool declares an output schema, output parse failures SHALL be
treated as tool implementation/runtime failures rather than model-repairable
input failures.

#### Scenario: Invalid executor output

- **WHEN** a Zod-authored tool executor returns output that fails its output
  schema
- **THEN** Junior treats that failure as a tool execution error
- **AND** the failure is not classified as `tool_input_error`.

### Requirement: Host Zod Tool Result Modes

Host-owned `zodTool(...)` SHALL support structured mode by default and native
content mode only when no Junior-owned structured output schema is declared.

#### Scenario: Structured host tool

- **WHEN** a host-owned Zod tool declares `outputSchema`
- **THEN** the schema extends the shared Junior result object
- **AND** the executor returns the schema-shaped details object
- **AND** Junior validates the returned details against the declared schema.

#### Scenario: Native content host tool

- **WHEN** a host-owned Zod tool omits `outputSchema`
- **THEN** the executor returns `{ content }` only
- **AND** the executor does not author tool-specific `details`.

#### Scenario: Native content returned by a structured host tool

- **WHEN** a host-owned Zod tool declares `outputSchema`
- **AND** its executor returns `{ content }` without `details`
- **THEN** Junior treats the output as a runtime contract failure.

### Requirement: Existing Schema Sources Remain Compatible

The adapter layer SHALL preserve existing support for TypeBox-authored tools,
provider-owned MCP schemas, and plugin-owned tool schemas during migration.

#### Scenario: Non-Zod tool schema

- **WHEN** a tool is not authored through `zodTool(...)`
- **THEN** the existing schema and prepare/execute behavior remains unchanged.

### Requirement: Zod-Authored Plugin Tools

Plugin-authored tools SHALL support a public `definePluginTool(...)` helper
that accepts a Zod input schema and infers the plugin executor input type from
that schema. First-party plugin tools authored through this helper SHALL declare
a structured `outputSchema`.

#### Scenario: Plugin model-facing parameters

- **WHEN** a plugin tool is authored with `definePluginTool(...)`
- **THEN** the helper exposes JSON Schema-compatible tool parameters to Junior
  and Pi
- **AND** the plugin executor receives the Zod-parsed output type.

#### Scenario: Plugin parse failure

- **WHEN** model-generated plugin tool arguments fail the helper's Zod schema
- **THEN** the parse failure is converted to `PluginToolInputError`
- **AND** Pi records a tool result with `isError=true`.

#### Scenario: Existing plugin definitions

- **WHEN** a plugin continues to provide an existing tool definition without
  `definePluginTool(...)`
- **THEN** Junior preserves that tool's existing schema and prepare/execute
  behavior.
