## ADDED Requirements

### Requirement: Integration Test Scope

Junior integration tests SHALL validate real runtime and product behavior across module boundaries.

#### Scenario: Runtime behavior is deterministic

- **WHEN** a behavior crosses handler, runtime, persistence, Slack, auth, tool, scheduler, MCP, sandbox, or package discovery boundaries
- **AND** it does not depend on model interpretation
- **THEN** it SHALL be tested with integration coverage by default

#### Scenario: Behavior depends on model interpretation

- **WHEN** the contract is natural-language routing, prompt behavior, reply quality, or conversational continuity
- **THEN** it SHALL be tested as an eval instead of integration

### Requirement: Real Runtime Wiring

Junior integration tests SHALL exercise production runtime wiring for the behavior path.

#### Scenario: Integration behavior test runs

- **WHEN** a behavior integration test drives a Slack or runtime scenario
- **THEN** it SHALL use real runtime modules, state handling, routing, and delivery planning for the path under test
- **AND** it MAY replace only the agent/reply generation boundary with deterministic fake output

#### Scenario: Runtime internals are mocked

- **WHEN** a test uses runtime module mocks, singleton patching, ad-hoc persistence fakes, or fake Slack delivery layers to prove a product workflow
- **THEN** it SHALL NOT be considered an acceptable integration behavior test

### Requirement: Slack And HTTP Fixtures

Junior integration tests SHALL use shared HTTP and Slack fixtures for external contracts.

#### Scenario: Slack API behavior is asserted

- **WHEN** a test needs Slack API request, response, retry, pagination, or error behavior
- **THEN** it SHALL use the shared MSW Slack handlers and fixture factories
- **AND** it SHALL NOT directly stub Slack SDK or Slack fetch calls in the test file

#### Scenario: Inbound Slack payload is constructed

- **WHEN** an integration test constructs inbound Slack events or API responses
- **THEN** it SHOULD use shared Slack fixture factories when available

### Requirement: Behavior And Transport Contract Separation

Junior integration tests SHALL keep scenario behavior and low-level transport contracts readable and separate.

#### Scenario: Test proves user-visible behavior

- **WHEN** a test is a behavior integration test
- **THEN** it SHALL describe the user/runtime scenario
- **AND** it SHALL assert user-visible results before incidental request details

#### Scenario: Test proves Slack request payload shape

- **WHEN** Slack API payload shape, recipient metadata, ordering, stream lifecycle, retry behavior, or error mapping is the external contract
- **THEN** the test SHALL be clearly contract-focused
- **AND** it SHOULD live in a `*contract*.test.ts` file or clearly separated contract suite

### Requirement: Workflow Coverage

Junior integration tests SHALL cover workflow-boundary behavior when workflow routing is the contract.

#### Scenario: Workflow ingress is tested

- **WHEN** an integration test covers queued or workflow-routed Slack ingress
- **THEN** it SHALL verify serialized message/thread payloads are usable by the worker path
- **AND** it SHALL exercise real message-kind routing such as `new_mention` versus `subscribed_message`
- **AND** it SHALL validate relevant de-dup behavior at ingress or stream processing boundaries

### Requirement: Context-Bound Tool Coverage

Junior integration tests SHALL verify context-bound tool behavior at real runtime boundaries.

#### Scenario: Tool target comes from runtime context

- **WHEN** Slack channel, canvas, list, or similar context-bound tools are tested
- **THEN** assertions SHALL verify the target comes from harness/runtime context rather than model-supplied identifiers
- **AND** missing context SHALL fail safely with an actionable error

### Requirement: Integration Scope Discipline

Junior integration tests SHALL avoid exhaustive branch testing when one representative scenario proves the contract.

#### Scenario: New integration coverage is added

- **WHEN** a product/runtime contract needs integration coverage
- **THEN** tests SHOULD cover one representative happy path
- **AND** they SHOULD add only realistic failure or edge cases that change safety, routing, persistence, or external-contract semantics

### Requirement: Integration Verification

Junior integration test changes SHALL be verified with focused or package-level Vitest commands.

#### Scenario: Integration test file changes

- **WHEN** an integration test file is added or modified
- **THEN** the focused package Vitest command for that file SHOULD pass

#### Scenario: Boundary policy is relevant

- **WHEN** Slack behavior integration tests or eval files change
- **THEN** the Slack test boundary check SHOULD pass
