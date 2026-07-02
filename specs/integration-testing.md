# Integration Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-07-02

## Purpose

Integration tests cover product/runtime behavior through real wiring with a
deterministic fake agent boundary when needed. Layer-selection judgment lives in
`../policies/testing.md`.

## Use For

- Slack event ingestion, routing, delivery, and HTTP contracts.
- Auth callback and resume flows.
- Runtime orchestration with real persistence/routing.
- User-visible behavior that does not require model interpretation.
- API or handler behavior through the real app path.

## Mechanics

- Preferred path: `packages/junior/tests/integration/**`.
- Use real app/runtime modules for behavior paths.
- Use MSW handlers and Slack fixtures for outbound Slack HTTP.
- Substitute only the approved fake-agent/composition boundary for behavior
  tests.
- Assert user-visible output or external contract effects before internal
  context details.

## Behavior vs Transport Contract

- Behavior tests assert scenario outcomes first.
- Slack transport-contract tests may assert request payload shape, ordering, or
  recipient metadata when that shape is the external contract.
- Keep low-level Slack request assertions in dedicated contract-focused tests or
  clearly separated suites.

## Do Not Use

- Runtime module mocks for behavior paths.
- Ad hoc Slack HTTP stubs when MSW can express the contract.
- Fake persistence and fake delivery together to simulate a product workflow.

## Related Harness Docs

- Slack MSW and fixtures: `./slack-http-mocking.md`
- Harness tool targeting: `./harness-tool-context.md`
