## ADDED Requirements

### Requirement: Pi turn execution

Junior SHALL execute assistant turns through a Pi `Agent` harness that restores known history, runs exactly one current prompt or continuation, and returns a structured assistant reply.

#### Scenario: Fresh turn runs

- **WHEN** Junior starts a normal assistant turn
- **THEN** it SHALL instantiate a fresh Pi agent with the static system prompt, restored durable Pi history when available, current tools, selected model, and selected thinking level

#### Scenario: Resumed turn runs

- **WHEN** Junior resumes an awaiting session
- **THEN** it SHALL assign restored Pi messages to `agent.state.messages` and call `continue()` instead of replaying the original user prompt

#### Scenario: Current user prompt runs

- **WHEN** Junior runs a non-resumed turn
- **THEN** it SHALL prompt the agent with only the current turn message plus allowed per-turn runtime context

### Requirement: Thinking-level routing

Junior SHALL select a main-turn thinking level before creating the Pi agent and SHALL use conservative defaults for substantive work.

#### Scenario: Classifier succeeds

- **WHEN** the thinking-level classifier returns a valid selection
- **THEN** Junior SHALL use that selection to configure the main Pi agent turn

#### Scenario: Classifier fails or is uncertain

- **WHEN** Junior cannot confidently classify a substantive turn
- **THEN** it SHALL fall back to medium reasoning rather than shallow reasoning

#### Scenario: Turn has thread/source context

- **WHEN** a non-trivial turn includes thread background, attachments, source context, likely tools, or source verification
- **THEN** Junior SHALL avoid routing it to no/low reasoning unless the turn is genuinely trivial

### Requirement: Final output resolution

Junior SHALL resolve user-visible harness output from terminal assistant text and safe side-effect success, not from provisional tool narration.

#### Scenario: Assistant text appears before a tool result

- **WHEN** assistant narration appears before the last tool-result message
- **THEN** Junior SHALL NOT use that narration as final reply text

#### Scenario: Assistant text appears after tool results

- **WHEN** terminal assistant messages appear after the last tool-result message
- **THEN** Junior SHALL join their text, trim it, and use it as the primary reply text

#### Scenario: Text is empty with no successful side effect

- **WHEN** final assistant text is empty and no successful side-effect-only delivery applies
- **THEN** Junior SHALL return an execution-failure outcome with explicit fallback behavior

#### Scenario: Text is raw tool payload or execution escape

- **WHEN** final assistant text is a raw tool-call payload or execution-deferral escape shape
- **THEN** Junior SHALL treat the turn as an execution failure instead of surfacing that payload

#### Scenario: Successful side effect needs no text

- **WHEN** a requested Slack side effect or file output succeeds and thread text would be redundant
- **THEN** Junior MAY mark the harness result successful with a delivery plan that suppresses thread text

### Requirement: Streaming callbacks

Junior SHALL treat Pi text streaming callbacks as non-authoritative progress previews.

#### Scenario: Pi emits text delta

- **WHEN** Pi emits `message_update` / `text_delta`
- **THEN** Junior SHALL forward the text to the configured callback when present

#### Scenario: Consecutive assistant messages stream

- **WHEN** text deltas come from consecutive assistant messages
- **THEN** Junior SHALL insert a separator so streamed text remains readable relative to final joined output

#### Scenario: Streaming callback fails

- **WHEN** an assistant-message-start or text-delta callback throws
- **THEN** Junior SHALL log the failure and continue the harness turn

### Requirement: Timeout handling

Junior SHALL bound harness execution with a turn timeout and abort Pi before deriving timeout recovery state.

#### Scenario: Pi execution exceeds timeout

- **WHEN** the turn exceeds `AGENT_TURN_TIMEOUT_MS`
- **THEN** Junior SHALL call `agent.abort()`, wait for the in-flight prompt/continue call to settle, and snapshot Pi messages after settlement

#### Scenario: Safe resumability context exists

- **WHEN** timeout occurs and a safe resumable session boundary can be persisted
- **THEN** Junior SHALL throw a retryable timeout error carrying resume correlation metadata

#### Scenario: No safe resumability context exists

- **WHEN** timeout occurs but no safe resumable boundary can be persisted
- **THEN** Junior SHALL return through the provider-error/failure reply path

### Requirement: Provider retry before final output

Junior SHALL retry transient provider failures only before final output is resolved and only from a safe Pi continuation boundary.

#### Scenario: Retryable provider error appears

- **WHEN** the terminal assistant message represents a retryable provider failure
- **THEN** Junior MAY trim that error tail, persist the safe projection, back off, and call `continue()`

#### Scenario: Retry succeeds

- **WHEN** provider retry succeeds
- **THEN** Junior SHALL include cumulative usage/diagnostics and return the recovered assistant reply

#### Scenario: Retry cannot continue safely

- **WHEN** no safe boundary remains or retry limit is exhausted
- **THEN** Junior SHALL stop retrying and use normal provider-failure handling

### Requirement: Harness diagnostics

Junior SHALL return structured turn diagnostics with every harness reply.

#### Scenario: Turn succeeds

- **WHEN** the harness resolves a successful reply or successful side-effect-only result
- **THEN** diagnostics SHALL include outcome, model id, assistant message count, tool call names, tool result count, tool error count, primary-text usage, thinking level when selected, duration when available, and usage when available

#### Scenario: Provider failure occurs

- **WHEN** provider/runtime execution fails
- **THEN** diagnostics SHALL mark `provider_error` and include an error message when available

#### Scenario: Execution failure occurs

- **WHEN** output is empty, escaped, or raw payload-like without valid side-effect success
- **THEN** diagnostics SHALL mark `execution_failure`

### Requirement: Harness verification taxonomy

Harness verification SHALL keep deterministic output mechanics separate from model-quality and Slack-delivery behavior.

#### Scenario: Output resolution is verified

- **WHEN** verifying terminal output extraction, side-effect-only success, empty fallback, or diagnostics shape
- **THEN** the primary layer SHALL be unit tests around `buildTurnResult(...)` or narrow harness tests

#### Scenario: Pi loop/resume behavior is verified

- **WHEN** verifying `prompt()` vs `continue()`, timeout abort, provider retry, or callback behavior
- **THEN** the primary layer SHALL be unit/integration tests with a mocked Pi agent or local runtime fixture

#### Scenario: User-visible answer quality is verified

- **WHEN** verifying whether the final answer is useful, source-grounded, or follows instructions
- **THEN** the primary layer SHALL be evals or Slack behavior integration tests, not harness unit tests
