# Backfill Slack HTTP Mocking Specs

## Why

Slack HTTP mocking is the transport-contract foundation for Junior integration tests. Existing prose specs and MSW fixtures define strict network isolation, Slack API handlers, request capture, response queues, and fixture factories. This needs an OpenSpec baseline.

## What Changes

- Add `slack-http-mocking` requirements for MSW lifecycle, unhandled request policy, Slack API handler behavior, fixture factories, request capture, queued responses, private file upload/download handling, and authoring rules.

## Out of Scope

- General integration testing policy.
- Live Slack testing.
- Evals judging behavior.

## Impact

Slack contract tests can stay deterministic and centralized instead of ad-hoc stubbing Slack clients.
