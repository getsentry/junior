# Backfill Integration Testing Specs

## Why

Integration tests are the default layer for Junior runtime/product behavior. They cover Slack ingress, runtime wiring, persistence, auth flows, Slack HTTP contracts, tool behavior, and deterministic fake-agent outcomes. The existing prose spec needs an OpenSpec baseline.

## What Changes

- Add `integration-testing` requirements for real runtime wiring, allowed fake-agent seams, MSW/fixture use, behavior versus transport-contract suites, workflow coverage, context-bound tools, and verification.

## Out of Scope

- Slack MSW fixture implementation details, which belong to `slack-http-mocking`.
- Agent-facing model behavior, which belongs to `eval-testing`.
- Moving existing tests.

## Impact

New integration tests should prove real product behavior without broad runtime mocks or ad-hoc Slack stubs.
