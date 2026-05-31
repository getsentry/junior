## ADDED Requirements

### Requirement: MSW Lifecycle

Junior SHALL use centralized MSW setup for Slack HTTP tests.

#### Scenario: Test runtime starts

- **WHEN** Vitest setup runs for Junior tests or evals
- **THEN** the MSW server SHALL start before tests execute
- **AND** test-safe Slack credentials SHALL be set before runtime modules read Slack config

#### Scenario: Test case finishes

- **WHEN** a test case finishes
- **THEN** queued Slack responses, captured Slack requests, and handler state SHALL be reset

#### Scenario: Test suite finishes

- **WHEN** the test suite finishes
- **THEN** the MSW server SHALL close

### Requirement: Unhandled HTTP Policy

Junior tests SHALL fail on unhandled external Slack or provider HTTP unless explicitly allowed.

#### Scenario: Unhandled external request occurs

- **WHEN** an external HTTP request is not handled by MSW and is not an approved live test host
- **THEN** the request SHALL fail with an `[HTTP MOCK]` error

#### Scenario: Approved live test host is used

- **WHEN** a request targets an approved local/model/sandbox/eval fixture host
- **THEN** the unhandled request policy MAY allow it according to the shared HTTP allowlist

### Requirement: Slack API Handler Contract

Slack API handlers SHALL centralize supported method behavior.

#### Scenario: Supported Slack method is called

- **WHEN** code calls a supported Slack Web API method
- **THEN** the handler SHALL parse request parameters from JSON, form-url-encoded, or multipart bodies
- **AND** it SHALL capture normalized headers and params for contract assertions
- **AND** it SHALL return a queued response when one exists or a deterministic default response otherwise

#### Scenario: Adapter-scoped Slack id reaches Slack API

- **WHEN** a captured Slack request uses a `slack:<id>` adapter-scoped conversation id where Slack expects a raw conversation id
- **THEN** the handler SHALL return a Slack-style error response

#### Scenario: Unsupported Slack method is needed

- **WHEN** production code starts calling a Slack method not listed by the handler
- **THEN** tests SHALL add explicit handler support and fixture coverage for that method before relying on it

### Requirement: Slack Response Queues And Captures

Slack contract tests SHALL use handler utilities to control responses and inspect requests.

#### Scenario: Test needs a Slack error, rate limit, pagination, or custom success payload

- **WHEN** a Slack integration test needs method-specific behavior
- **THEN** it SHALL queue the response through shared Slack handler utilities
- **AND** it SHALL NOT stub the Slack client or fetch call directly

#### Scenario: Test asserts Slack request shape

- **WHEN** Slack request payload shape is the contract
- **THEN** the test SHALL inspect captured Slack API calls from the shared handler
- **AND** it SHOULD assert only fields relevant to the behavior contract

### Requirement: Slack Fixture Factories

Junior tests SHALL prefer shared Slack fixture factories for Slack payloads.

#### Scenario: Slack success or error payload is needed

- **WHEN** a test needs a Slack API response payload
- **THEN** it SHOULD use `slackOk`, `slackError`, or method-specific factory helpers

#### Scenario: Inbound Slack event is needed

- **WHEN** a test needs Slack webhook or event payloads
- **THEN** it SHOULD use shared event and id factories when available

### Requirement: Slack HTTP Mocking Boundaries

Slack HTTP mocking SHALL remain an integration transport-contract tool, not an eval assertion tool.

#### Scenario: Eval file tries to assert Slack HTTP details

- **WHEN** an eval imports Slack MSW queue or capture helpers
- **THEN** boundary enforcement SHALL fail or review SHALL reject the eval

#### Scenario: Behavior integration test uses MSW

- **WHEN** a behavior integration test uses MSW incidentally
- **THEN** it SHOULD keep user-visible assertions primary and leave detailed payload assertions to contract-focused tests

### Requirement: Slack HTTP Mocking Verification

Slack HTTP handler changes SHALL be verified by integration tests.

#### Scenario: Handler method support changes

- **WHEN** a Slack handler adds or changes supported method behavior
- **THEN** a focused integration test SHALL cover the request/response contract

#### Scenario: Fixture factory changes

- **WHEN** Slack fixture factories change
- **THEN** tests using those factories SHALL prove the generated payload remains compatible with consumed runtime fields
