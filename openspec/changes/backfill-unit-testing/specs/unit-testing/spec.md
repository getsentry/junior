## ADDED Requirements

### Requirement: Unit Test Scope

Junior unit tests SHALL validate local deterministic invariants.

#### Scenario: Pure or local logic is tested

- **WHEN** a test targets a parser, validator, normalizer, pure transform, retry calculation, routing heuristic, formatting helper, or small deterministic adapter
- **THEN** it MAY be written as a unit test
- **AND** it SHALL assert the local output, state transition, or thrown error for that unit

#### Scenario: Runtime workflow is tested

- **WHEN** the behavior requires real Slack delivery, handler routing, persistence, auth resume, or multi-module runtime orchestration
- **THEN** it SHALL NOT be covered primarily by a unit test
- **AND** it SHALL be moved to integration or eval according to the `testing` taxonomy

### Requirement: Unit Mocking

Junior unit tests SHALL use mocks and fakes only to isolate one local invariant.

#### Scenario: Narrow boundary is mocked

- **WHEN** a unit test replaces a clock, random id source, command runner, small dependency, or one explicit boundary service
- **THEN** the mock SHALL be scoped to the invariant under test
- **AND** assertions SHOULD remain about the unit result rather than incidental call choreography

#### Scenario: Multiple runtime layers are mocked

- **WHEN** a test mocks persistence, Slack delivery, runtime handlers, and reply execution together to simulate one user-visible workflow
- **THEN** it SHALL NOT be considered an acceptable unit test

### Requirement: Unit Network Isolation

Junior unit tests SHALL avoid real network access.

#### Scenario: External behavior is needed

- **WHEN** a unit test needs HTTP-like behavior
- **THEN** it SHALL use local fakes, MSW only when appropriate for the tested module, or a deterministic fixture
- **AND** it SHALL NOT contact Slack or provider networks

### Requirement: Unit Placement And Naming

Junior unit tests SHALL live under the unit test tree and describe local behavior.

#### Scenario: Unit test file is added

- **WHEN** a unit test is added for `@sentry/junior`
- **THEN** it SHOULD be placed under `packages/junior/tests/unit/**`
- **AND** the test title SHOULD describe the local invariant or outcome

### Requirement: Unit Assertion Discipline

Junior unit tests SHALL avoid brittle or wrong-layer assertions.

#### Scenario: Prompt behavior is tested

- **WHEN** model-facing prompt behavior is the contract
- **THEN** the behavior SHOULD be covered by evals or integration tests
- **AND** unit tests SHALL NOT assert exact prompt prose or substring presence as the stable contract

#### Scenario: Observability is incidental

- **WHEN** logs, spans, or trace attributes are not the tested product contract
- **THEN** unit tests SHALL NOT assert those emissions

### Requirement: Unit Verification

Junior unit test changes SHALL be verified with focused Vitest commands when practical.

#### Scenario: Unit test file changes

- **WHEN** a unit test file is added or modified
- **THEN** the focused package Vitest command for that file SHOULD pass

#### Scenario: Shared unit helper changes

- **WHEN** a shared parser, validator, normalizer, or deterministic helper changes
- **THEN** representative unit tests for its success and failure cases SHOULD pass
