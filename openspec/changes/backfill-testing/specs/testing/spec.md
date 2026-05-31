## ADDED Requirements

### Requirement: Mandatory Layer Selection

Junior tests SHALL be classified by product contract before assertions or mocks are chosen.

#### Scenario: Contract depends on model interpretation

- **WHEN** the behavior depends on natural-language interpretation, prompt behavior, reply quality, multi-turn continuity, or conversational routing
- **THEN** the test SHALL be an eval unless another spec explicitly defines a deterministic non-model contract

#### Scenario: Contract is runtime or product wiring

- **WHEN** the behavior is user-visible runtime behavior, Slack-facing behavior, persistence, routing, auth resume, handler behavior, or external API contract behavior that does not depend on model interpretation
- **THEN** the test SHALL be an integration test by default

#### Scenario: Contract is local deterministic logic

- **WHEN** the behavior is a pure transform, parser, scoring function, retry calculation, normalization helper, or tight local invariant
- **THEN** the test MAY be a unit test

### Requirement: Layer Boundaries

Junior SHALL keep unit, integration, and eval layers focused on distinct evidence.

#### Scenario: Unit test is written

- **WHEN** a unit test is added or changed
- **THEN** it SHALL validate local deterministic behavior
- **AND** it SHALL NOT mock multiple runtime layers to simulate a user-visible workflow

#### Scenario: Integration test is written

- **WHEN** an integration test is added or changed
- **THEN** it SHALL exercise real runtime/app wiring for the behavior path
- **AND** it MAY substitute a deterministic fake agent at the approved agent boundary
- **AND** it SHALL use shared HTTP fixtures for Slack or provider transport contracts

#### Scenario: Eval is written

- **WHEN** an eval is added or changed
- **THEN** it SHALL run through the eval harness as a realistic conversation
- **AND** it SHALL judge user-visible behavior through structured criteria
- **AND** it SHALL NOT assert low-level Slack HTTP payload shapes

### Requirement: Network Isolation

Junior tests and evals SHALL prevent accidental external network access.

#### Scenario: Test performs external HTTP

- **WHEN** a unit or integration test needs external HTTP behavior
- **THEN** it SHALL use MSW, shared HTTP interceptors, or an approved local fixture
- **AND** real Slack network access SHALL be blocked

#### Scenario: Eval requires external model or sandbox access

- **WHEN** an eval runs through the behavior harness
- **THEN** model, Vercel AI Gateway, Vercel Sandbox, or configured replay traffic MAY be live according to eval harness configuration
- **AND** unrelated external HTTP SHALL be controlled through replay or fixtures

### Requirement: Shared Fixtures

Junior tests SHALL prefer shared fixtures for common external contracts.

#### Scenario: Slack event or API payload is needed

- **WHEN** a test constructs Slack inbound events or Slack API responses
- **THEN** it SHOULD use the shared Slack fixture factories when available
- **AND** transport-contract assertions SHOULD use the shared MSW capture helpers rather than ad-hoc HTTP stubs

#### Scenario: Reusable harness exists

- **WHEN** a test can use a repository harness or memory-backed adapter to exercise the real boundary
- **THEN** it SHOULD use that harness instead of creating bespoke fake stores or fake Slack delivery layers

### Requirement: Mock Confidence

Junior tests SHALL mock only the boundary allowed by their layer.

#### Scenario: Mock proves a local invariant

- **WHEN** a mock replaces a clock, random id, local dependency, or one narrow deterministic boundary
- **THEN** a unit test MAY use that mock

#### Scenario: Mock hides the behavior under test

- **WHEN** a test must mock persistence, Slack delivery, runtime handlers, and reply execution together to prove one product outcome
- **THEN** the test SHALL be reclassified as integration or eval
- **AND** the broad mocked test SHOULD be deleted or narrowed to a local invariant

#### Scenario: Observability is incidental

- **WHEN** logs, spans, or trace attributes are not the product contract
- **THEN** tests SHALL NOT assert them as behavior requirements

### Requirement: Coverage Budget

Junior tests SHALL cover meaningful contracts without duplicating low-signal permutations.

#### Scenario: New behavior is tested

- **WHEN** a new behavior contract needs coverage
- **THEN** tests SHOULD cover a representative happy path
- **AND** they SHOULD add failure or boundary cases only when those cases represent distinct realistic risk

#### Scenario: Proposed test duplicates an existing contract

- **WHEN** a new test does not add a distinct contract guarantee compared to existing unit, integration, or eval coverage
- **THEN** it SHOULD NOT be added

### Requirement: Boundary Enforcement

Junior SHALL enforce high-risk testing boundaries with scripts where practical.

#### Scenario: Package tests run

- **WHEN** `@sentry/junior` tests run through the package test script
- **THEN** the Slack/test boundary check SHALL run before the Vitest suite

#### Scenario: Boundary check detects forbidden patterns

- **WHEN** eval files import Slack contract internals or use Slack MSW capture helpers
- **OR** designated Slack behavior integration tests use runtime module mocks
- **THEN** the boundary check SHALL fail with file and line information

### Requirement: Verification Command Selection

Junior changes SHALL run verification commands matching the affected contract.

#### Scenario: Unit or integration file is changed

- **WHEN** a specific unit or integration test file is changed
- **THEN** the focused package Vitest command for that file SHOULD be run

#### Scenario: Eval file is changed

- **WHEN** an eval file is changed
- **THEN** the focused eval command for that file SHOULD be run when credentials/replay mode allow it
- **AND** missing external credentials SHALL be reported explicitly

#### Scenario: Cross-layer behavior changes

- **WHEN** a change affects runtime contracts, prompts, tools, Slack behavior, or eval harness behavior across layers
- **THEN** the relevant spec verification map SHALL identify the smallest sufficient set of unit, integration, eval, typecheck, build, or docs commands
