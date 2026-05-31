## ADDED Requirements

### Requirement: Internal Dispatch Ownership

Junior SHALL treat `chat/agent-dispatch/*` as the internal implementation boundary for the `trusted-plugin-dispatch` capability, not as a separate public product API.

#### Scenario: Trusted plugin dispatch behavior changes

- **WHEN** a change modifies plugin-facing dispatch behavior, dispatch state transitions, retries, recovery, continuation, Slack delivery, authorization blocking, limits, or plugin projections
- **THEN** the canonical OpenSpec behavior change SHALL be made under `trusted-plugin-dispatch`
- **AND** `agent-dispatch` SHALL only be updated for internal ownership or module-boundary invariants

#### Scenario: Internal agent-dispatch module is refactored

- **WHEN** code under `chat/agent-dispatch/*` is refactored without changing public dispatch behavior
- **THEN** it SHALL preserve the `trusted-plugin-dispatch` behavior contract
- **AND** it SHALL preserve the internal invariants specified by `agent-dispatch`

### Requirement: Callback Boundary

Agent dispatch callbacks SHALL be authenticated and version-bound before any dispatched agent slice runs.

#### Scenario: Callback request enters the handler

- **WHEN** `/api/internal/agent-dispatch` receives a request
- **THEN** the handler SHALL verify the signed callback envelope before invoking the runner
- **AND** invalid callbacks SHALL receive `401`
- **AND** valid callbacks SHALL be acknowledged without exposing raw dispatch state to the caller

#### Scenario: Callback runner is scheduled

- **WHEN** a valid callback is accepted
- **THEN** the handler SHALL schedule exactly one bounded runner invocation for the verified dispatch id and expected version
- **AND** runner errors SHALL be logged without leaking dispatch input, destination, credentials, or plugin-private metadata into the response

### Requirement: Stable Synthetic Turn Identity

Agent dispatch runner slices SHALL use stable synthetic conversation and turn identities.

#### Scenario: Dispatch runner builds context

- **WHEN** a dispatch slice runs
- **THEN** it SHALL derive the conversation id from the Slack team and channel destination
- **AND** it SHALL derive the turn id from the dispatch id
- **AND** it SHALL upsert the synthetic user message with id `dispatch:<dispatch.id>:user`
- **AND** it SHALL upsert the synthetic assistant message with id `dispatch:<dispatch.id>:assistant`

#### Scenario: Dispatch runner resumes a timed-out slice

- **WHEN** timeout continuation schedules another dispatch callback
- **THEN** the next slice SHALL use the same dispatch id, conversation id, turn id, synthetic message ids, actor, destination, and persisted Pi/conversation state

### Requirement: Internal State Privacy

Agent dispatch implementation SHALL keep raw dispatch records internal to core.

#### Scenario: Plugin reads dispatch state

- **WHEN** a trusted plugin reads dispatch status
- **THEN** it SHALL receive only the plugin-visible projection defined by `trusted-plugin-dispatch`
- **AND** raw input, destination, actor, credential subject, metadata, attempt, lease, version, conversation, tool-call, and callback fields SHALL remain core-internal

#### Scenario: Runner logs or handles failure

- **WHEN** a dispatch slice fails
- **THEN** failure recording and logging SHALL use dispatch ids and safe correlation fields
- **AND** it SHALL NOT expose stored dispatch input or credential-bearing state outside core-owned persistence and redacted telemetry

### Requirement: Queue Dispatch Separation

Agent dispatch SHALL remain separate from queued inbound Slack thread message dispatch.

#### Scenario: User-authored Slack event is dequeued

- **WHEN** a queued Slack message is dispatched through `thread-message-dispatcher`
- **THEN** it SHALL route through the interactive Slack runtime as a user-authored Slack message
- **AND** it SHALL NOT create agent-dispatch records
- **AND** it SHALL NOT run as a trusted-plugin system actor

#### Scenario: Trusted plugin dispatches background work

- **WHEN** a trusted plugin creates a durable agent dispatch
- **THEN** it SHALL route through the agent-dispatch callback/runner path
- **AND** it SHALL NOT reuse inbound Slack message queue dispatch as the system-turn execution mechanism

### Requirement: Agent Dispatch Verification Ownership

Agent dispatch implementation changes SHALL be verified at deterministic internal boundaries while behavior assertions remain under `trusted-plugin-dispatch`.

#### Scenario: Validation or signing code changes

- **WHEN** option validation, callback signing, or callback verification changes
- **THEN** unit tests SHALL cover accepted and rejected cases

#### Scenario: Runner internals change

- **WHEN** synthetic turn identity, system actor context, state persistence, Slack delivery idempotency, timeout continuation, or auth blocking changes
- **THEN** integration tests SHALL cover the cross-module behavior

#### Scenario: Queue dispatcher code changes

- **WHEN** `thread-message-dispatcher` changes
- **THEN** tests SHALL verify queued inbound Slack message routing separately from agent-dispatch behavior
