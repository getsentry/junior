# Tool Result Contracts

## ADDED Requirements

### Requirement: Junior-Owned Structured Result Mode

Junior-owned high-leverage tools SHALL support a structured result mode that
captures the tool outcome in stable fields while remaining compatible with Pi's
`AgentToolResult` transport shape.

#### Scenario: Structured result returned to Pi

- **WHEN** a converted Junior-owned structured tool completes
- **THEN** it returns Pi-compatible `content` and `details`
- **AND** `details` contains the structured Junior result object
- **AND** `content` contains a deterministic compact representation of the same
  result object for the model.

### Requirement: Native Content Bridge Mode

Junior-owned provider bridge tools SHALL preserve native model content when
structured text would hide multimodal provider payloads.

#### Scenario: MCP tool returns image content

- **WHEN** a managed MCP tool returns image content
- **THEN** Junior passes the native text/image content to Pi `content`
- **AND** the managed MCP layer records provider/tool identity and raw provider
  output through its own tracing/logging
- **AND** the returned tool result does not author tool-specific `details`
- **AND** Junior does not replace the image content with only a structured JSON
  summary.

#### Scenario: MCP tool returns structuredContent without image content

- **WHEN** a managed MCP tool returns `structuredContent` and no image content
- **THEN** Junior may use the structured provider payload as model-visible text
- **AND** the managed MCP layer may trace the provider's raw content according to
  conversation privacy.

### Requirement: Model-Visible Result Facts

Structured result fields needed for follow-up work SHALL be visible to the
model, not only stored in `details`.

#### Scenario: Model needs to continue from a partial result

- **WHEN** a tool result is partial, truncated, or paginated
- **THEN** the model-visible `content` includes `truncated=true`
- **AND** the model-visible `content` includes the exact continuation data
  needed to request the next slice.

### Requirement: Continuation Data

Tools that return partial or paginated data SHALL include structured
continuation data when a deterministic next tool call exists.

#### Scenario: File read returns a partial range

- **WHEN** `readFile` returns only part of a file
- **THEN** the structured result includes the path, returned line range, total
  line count when known, and `truncated=true`
- **AND** the result includes a continuation with the exact `readFile`
  arguments for the next line range.

#### Scenario: No deterministic continuation exists

- **WHEN** a tool returns partial data but cannot provide a safe exact next call
- **THEN** the structured result may omit `continuation`
- **AND** it still includes the reason the result is partial.

### Requirement: Structured Expected Errors

Expected operational failures that the model can repair or route around SHALL be
encoded as structured error results instead of ambiguous freeform text.

#### Scenario: Expected target miss

- **WHEN** a converted file or edit tool cannot find the requested target
- **THEN** the structured result includes `ok=false`, `status=error`, and an
  error `kind`
- **AND** the model-visible `content` includes the same error kind and target.

#### Scenario: Unexpected implementation failure

- **WHEN** a converted tool hits an unexpected runtime or implementation failure
- **THEN** the tool throws through the existing tool error path
- **AND** Junior does not encode the failure as a normal `ok=false` result.

### Requirement: Result Schema Validation

Converted tools SHALL validate declared result schemas at the tool boundary.

#### Scenario: Invalid implementation output

- **WHEN** a converted tool produces a result that does not match its declared
  result schema
- **THEN** Junior treats the failure as a runtime contract failure
- **AND** the failure is not classified as a model-repairable input error.

#### Scenario: Structured tool returns native content only

- **WHEN** a tool declares a Junior-owned structured result schema
- **AND** its executor returns `{ content }` without `details`
- **THEN** Junior treats the result as a runtime contract failure.

### Requirement: First-Slice Tool Coverage

The first structured-result implementation SHALL cover tools where reliable
follow-up or side-effect auditing materially affects agent behavior.

#### Scenario: First converted tools

- **WHEN** the first implementation slice is complete
- **THEN** `bash`, `readFile`, `grep`, `listDir`, `editFile`, `writeFile`,
  and `sendMessage` return structured result objects
- **AND** `callMcpTool` preserves provider-native model content without declaring
  a Junior `outputSchema`
- **AND** provider bridge tools preserve native model content when required for
  multimodal output
- **AND** existing non-Zod tools continue to work through the legacy result
  normalization path.

### Requirement: Pi Boundary Remains Generic

Junior SHALL treat Pi's tool result shape as a generic transport envelope rather
than the domain-level structured result contract.

#### Scenario: Pi transport compatibility

- **WHEN** Junior passes a structured tool result to Pi
- **THEN** the result conforms to Pi's `AgentToolResult` shape
- **AND** no Pi package changes are required for the Junior structured result
  contract.
