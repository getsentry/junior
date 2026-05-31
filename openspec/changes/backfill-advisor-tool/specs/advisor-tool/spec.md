## ADDED Requirements

### Requirement: Advisor availability and configuration

Junior SHALL expose the `advisor` tool only when advisor runtime context is configured.

#### Scenario: Advisor context is absent

- **WHEN** the agent tool registry is built without advisor runtime context
- **THEN** Junior SHALL omit the `advisor` tool

#### Scenario: Advisor context is present

- **WHEN** the agent tool registry is built with advisor runtime context
- **THEN** Junior SHALL expose the `advisor` tool to the main executor

#### Scenario: Advisor model is unset

- **WHEN** `AI_ADVISOR_MODEL` is unset
- **THEN** Junior SHALL use the configured default advisor model

#### Scenario: Advisor thinking level is unset

- **WHEN** `AI_ADVISOR_THINKING_LEVEL` is unset
- **THEN** Junior SHALL use the configured default advisor thinking level

#### Scenario: Advisor config is invalid

- **WHEN** the advisor model id or thinking level is invalid
- **THEN** Junior SHALL fail configuration loading rather than falling back silently

### Requirement: Advisor input contract

Junior SHALL require the executor to provide a focused advisor question and explicit curated context.

#### Scenario: Question is empty

- **WHEN** `advisor` receives a missing, non-string, or blank `question`
- **THEN** Junior SHALL return `ok:false` with `error_code: "invalid_question"`
- **AND** Junior SHALL not run advisor inference

#### Scenario: Context is empty

- **WHEN** `advisor` receives a missing, non-string, or blank `context`
- **THEN** Junior SHALL return `ok:false` with `error_code: "invalid_context"`
- **AND** Junior SHALL not run advisor inference

#### Scenario: Inputs are valid

- **WHEN** `advisor` receives non-empty `question` and `context`
- **THEN** Junior SHALL trim both values before constructing the advisor request

#### Scenario: Advisor request is constructed

- **WHEN** Junior invokes the advisor
- **THEN** Junior SHALL build one user message containing `<advisor-task>` and `<executor-context>` sections
- **AND** Junior SHALL XML-escape executor-supplied text inside those sections

### Requirement: Advisor context isolation

Junior SHALL isolate advisor context from the parent transcript.

#### Scenario: Parent transcript contains unsupplied evidence

- **WHEN** the executor does not include parent evidence in the advisor `context`
- **THEN** Junior SHALL NOT implicitly forward the parent transcript or parent tool results to the advisor

#### Scenario: Follow-up advisor call has new evidence

- **WHEN** the executor makes a follow-up advisor call
- **THEN** the executor SHOULD include new evidence and changed constraints in `context` rather than assuming advisor history contains them

#### Scenario: Advisor returns guidance

- **WHEN** the advisor completes successfully
- **THEN** Junior SHALL return the advisor assistant text as the tool result content without transforming it into user-facing prose

### Requirement: Advisor nested agent invocation

Junior SHALL invoke the advisor as its own Pi agent with advisor-specific model, thinking level, prompt, tools, and session id.

#### Scenario: Advisor run starts

- **WHEN** advisor input is valid and a parent conversation id exists
- **THEN** Junior SHALL create a Pi `Agent` using the advisor model, advisor thinking level, advisor system prompt, advisor-allowed tools, and advisor session id

#### Scenario: Stored advisor messages exist

- **WHEN** stored advisor messages exist for the parent conversation
- **THEN** Junior SHALL assign those messages to the advisor agent before prompting

#### Scenario: Advisor model produces no valid assistant text

- **WHEN** the advisor run finishes without a usable assistant message or with an error/aborted stop reason
- **THEN** Junior SHALL return `ok:false` with `error_code: "unavailable"`

#### Scenario: Advisor run throws

- **WHEN** advisor inference throws
- **THEN** Junior SHALL return `ok:false` with `error_code: "unavailable"`

### Requirement: Advisor tool subset

Junior SHALL expose only safe read-only tools to the advisor.

#### Scenario: Tool is annotated read-only

- **WHEN** a normal tool has `readOnlyHint: true` and `destructiveHint` is not `true`
- **THEN** Junior MAY include that tool in the advisor tool set

#### Scenario: Tool is mutating or user-visible

- **WHEN** a normal tool lacks `readOnlyHint: true` or has `destructiveHint: true`
- **THEN** Junior SHALL exclude that tool from the advisor tool set

#### Scenario: Tool can recurse or invoke MCP bridge

- **WHEN** a tool is `advisor`, `searchMcpTools`, or `callMcpTool`
- **THEN** Junior SHALL exclude it from the advisor tool set even if metadata would otherwise allow it

#### Scenario: Advisor needs a mutating action

- **WHEN** the advisor determines a mutating or user-visible action is needed
- **THEN** it SHALL recommend that action to the executor rather than performing it

### Requirement: Advisor session persistence

Junior SHALL persist advisor-private Pi message history by parent conversation id.

#### Scenario: Conversation id is unavailable

- **WHEN** the advisor runtime lacks a parent conversation id
- **THEN** Junior SHALL return `ok:false` with `error_code: "missing_conversation_id"`
- **AND** Junior SHALL NOT create an orphan advisor session

#### Scenario: Advisor history is loaded

- **WHEN** advisor history is loaded
- **THEN** Junior SHALL read from key `junior:<conversationId>:advisor_session`
- **AND** Junior SHALL clone returned messages before using them

#### Scenario: Advisor completes successfully

- **WHEN** advisor inference succeeds and produces a usable assistant message
- **THEN** Junior SHALL save the full advisor message history back to the advisor session key

#### Scenario: Advisor history cannot be loaded

- **WHEN** advisor history load fails
- **THEN** Junior SHALL return `ok:false` with `error_code: "session_unavailable"`

#### Scenario: Advisor history cannot be saved

- **WHEN** advisor history save fails
- **THEN** Junior SHALL return `ok:false` with `error_code: "session_unavailable"`

### Requirement: Advisor prompt policy

Junior SHALL frame the advisor as a senior technical reviewer for the executor.

#### Scenario: Advisor receives task

- **WHEN** the advisor is invoked
- **THEN** its system prompt SHALL require deep analysis of executor-supplied context
- **AND** SHALL require the advisor to distinguish evidence from inference

#### Scenario: Evidence is insufficient

- **WHEN** the supplied context is insufficient
- **THEN** the advisor SHALL identify the missing evidence the executor needs to gather

#### Scenario: Advice is produced

- **WHEN** the advisor provides guidance
- **THEN** it SHOULD identify the hard part, recommend a concrete plan or correction, call out blocking risks, and propose focused verification

#### Scenario: Advisor is asked for user-facing copy

- **WHEN** the advisor is invoked
- **THEN** it SHALL avoid writing user-facing prose unless that is explicitly part of the technical advice requested by the executor

### Requirement: Advisor failure result shape

Junior SHALL make advisor failures non-fatal to the main executor.

#### Scenario: Advisor fails before or during invocation

- **WHEN** advisor validation, session loading, inference, assistant extraction, or session saving fails
- **THEN** Junior SHALL return a tool result with text guidance, `ok:false`, and a stable `error_code`

#### Scenario: Advisor succeeds

- **WHEN** advisor inference succeeds and history is saved
- **THEN** Junior SHALL return a tool result with `ok:true` and the advisor memo as text content

#### Scenario: Executor receives advisor failure

- **WHEN** the main executor receives an advisor failure result
- **THEN** it MAY continue only when the next action is clear from verified evidence

### Requirement: Advisor observability

Junior SHALL trace advisor invocation as a nested agent call.

#### Scenario: Advisor is invoked

- **WHEN** the advisor run starts
- **THEN** Junior SHALL create an `ai.invoke_advisor` span with provider, operation, and requested model attributes

#### Scenario: Advisor usage is available

- **WHEN** advisor-generated messages include provider usage
- **THEN** Junior SHALL set standard usage attributes on the advisor span

#### Scenario: Advisor fails

- **WHEN** advisor validation after span start, session load/save, inference, or output extraction fails
- **THEN** Junior SHALL set the advisor span status to error

### Requirement: Advisor-tool verification taxonomy

Advisor-tool verification SHALL separate deterministic configuration/tool filtering, nested-agent runtime wiring, and model-facing advisor-use quality.

#### Scenario: Local configuration and tool filtering are verified

- **WHEN** verifying advisor config parsing, exposure gates, input validation, tool subset filtering, session keying, and store clone behavior
- **THEN** the primary coverage SHALL be unit or integration tests with fake agent streams

#### Scenario: Nested advisor runtime is verified

- **WHEN** verifying explicit context transfer, advisor tool availability, returned memo preservation, and session continuity
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Model-facing advisor use is verified

- **WHEN** verifying whether the main executor consults advisor on hard tasks and uses the guidance correctly
- **THEN** the primary coverage SHALL be evals owned with `agent-execution` and eval governance
