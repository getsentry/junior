# Testing Architecture Review, 2026-06-04

## Metadata

- Created: 2026-06-04
- Last Edited: 2026-06-04

## Purpose

Capture the current testing architecture review and the redesign queue that came
out of the cleanup branch. This is non-normative historical context; current
rules live in `../testing.md`, `../unit-testing.md`, `../component-testing.md`,
`../integration-testing.md`, `../eval-testing.md`, and `../../policies/test-adapters.md`.

## Completed Cleanup

- Enforced the Slack integration boundary so integration suites cannot use
  module mocks for behavior paths.
- Split oversized Slack integration suites by user-visible behavior contracts:
  turn continuation, auth pauses, thread continuity, subscribed routing/reply
  policy, image hydration/cache/file delivery, and heartbeat recovery.
- Split task-execution component coverage by durable contract: mailbox
  persistence, leases, mailbox injection, queue/callback contracts, Slack
  ingress, Slack routing, steering, continuations, and input commits.
- Split packaged plugin registry unit coverage into discovery, runtime
  metadata, credentials, MCP metadata, and env-var interpolation suites.
- Split sandbox egress proxy unit coverage into policy/env, forwarding,
  credential lease, and OIDC verification suites.
- Extracted lazy sandbox workspace boot/cache/replacement behavior from the
  broad `generateAssistantReply` runtime suite into
  `chat/sandbox/lazy-workspace` with direct unit coverage.
- Moved user-turn attachment/router-block assembly into `respond-helpers` so
  attachment prompt contracts are covered without exercising the full runtime
  reply path.
- Extracted the shared sandbox executor fake and workspace assertions into
  `tests/fixtures/sandbox-executor.ts` as the first step toward splitting the
  executor suite by lifecycle, bash, file-tool, and snapshot contracts.
- Split sandbox executor dependency snapshot boot/rebuild/retry coverage into
  `tests/unit/sandbox/executor-snapshots.test.ts`.
- Split sandbox executor bash execution, timeout, abort, env, and credential
  egress coverage into `tests/unit/sandbox/executor-bash.test.ts`.
- Split sandbox executor file-tool, cached executor, keepalive, and virtual
  skill-file coverage into `tests/unit/sandbox/executor-tools.test.ts`.
- Moved the remaining sandbox executor lifecycle/session-manager coverage into
  `tests/unit/sandbox/executor-lifecycle.test.ts`.
- Extracted shared `generateAssistantReply` runtime mocks into
  `tests/fixtures/respond-runtime.ts` for the provider-retry and timeout-resume
  suites, leaving each file focused on its fake Pi agent behavior and
  assertions.
- Added shared fixtures for recurring boundaries instead of leaving setup
  copied through behavior tests.

## Current Layer Assessment

The taxonomy in `../testing.md` is now directionally right:

- Integration by default for Slack-visible and product-wiring behavior.
- Component tests for deterministic orchestration across stores, queues, leases,
  and local ports.
- Evals for agent-facing language/routing/quality contracts.
- Unit tests only for local deterministic invariants.

The main risk is not the taxonomy. The risk is old unit suites that grew around
wide runtime entry points and then accumulated enough mocks to behave like
low-fidelity integration tests.

## Redesign Queue

### 1. Runtime Response Suites

Files:

- `packages/junior/tests/unit/runtime/respond-mcp-progressive-loading.test.ts`
- `packages/junior/tests/unit/runtime/respond-timeout-resume.test.ts`
- `packages/junior/tests/unit/runtime/respond-provider-retry.test.ts`

Problem:

These tests mock a broad runtime surface to drive `generateAssistantReply`-style
behavior. They often prove multi-module orchestration, prompt/tool/runtime
handoffs, auth pauses, or resume behavior from a unit layer.

`respond-lazy-sandbox.test.ts` is partially improved: pure attachment assembly
and lazy workspace cache/replacement mechanics now have direct unit coverage.
The remaining file still uses a mocked runtime seam to prove that
`generateAssistantReply` avoids sandbox booting unless a sandbox-backed tool is
used and preserves sandbox metadata on error replies.

`respond-provider-retry.test.ts` and `respond-timeout-resume.test.ts` now share a
single runtime mock fixture, which reduces duplication but does not change the
layer assessment: the tests still prove turn orchestration through a mocked
`generateAssistantReply` seam.

Direction:

- Move deterministic turn orchestration into component tests backed by explicit
  local ports for Pi events, tool execution, sandbox acquisition, auth parking,
  and session records.
- Keep only small pure helpers in unit suites.
- Use integration tests for user-visible Slack/runtime delivery effects.
- Use evals when the contract depends on natural-language interpretation.

### 2. Sandbox Executor Harness

File:

- `packages/junior/tests/unit/sandbox/executor-lifecycle.test.ts`
- `packages/junior/tests/unit/sandbox/executor-bash.test.ts`
- `packages/junior/tests/unit/sandbox/executor-tools.test.ts`
- `packages/junior/tests/unit/sandbox/executor-snapshots.test.ts`

Problem:

The old file covered at least five contracts in one mocked harness: sandbox
lifecycle, network policy refresh, bash execution, tool executor caching,
virtual skill files, file-tool errors, and runtime dependency snapshots.

Direction:

- Keep growing the dedicated sandbox executor fixture only for repeated
  sandbox/session-manager boundaries.
- Keep lifecycle, bash execution, tool/file behavior, and snapshot suites
  separate.
- Longer term, consider smaller production ports for sandbox boot, bash command
  execution, file tools, and snapshot resolution so tests do not need one
  enormous mock harness.

### 3. Large Slack/OAuth Integration Suites

Files:

- `packages/junior/tests/integration/slack-schedule-tools.test.ts`
- `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
- `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
- `packages/junior/tests/integration/oauth-callback-slack.test.ts`
- `packages/junior/tests/integration/turn-resume-slack.test.ts`

Problem:

These are often in the right layer, but several files mix route contract,
state persistence, Slack delivery, retries, and continuation behavior.

Direction:

- Keep them integration-level when they exercise real product wiring.
- Split by external contract: callback validation, Slack-visible delivery,
  persisted auth/session state, retry behavior, and resumed turn behavior.
- Avoid payload-order assertions outside dedicated transport-contract files.

### 4. CLI Check Suite

File:

- `packages/junior/tests/unit/cli/check-cli.test.ts`

Problem:

The suite is mostly legitimate unit/CLI validation, but setup is dense and mixes
plugin manifests, app config checks, deployment config checks, and skill checks.

Direction:

- Extract a CLI repo fixture builder.
- Split by check family: plugin manifests, app source config, deployment config,
  packaged plugin config defaults, and skill linting.

### 5. Routing Decision Tables

Files:

- `packages/junior/tests/unit/routing/subscribed-decision.test.ts`
- Other large routing/service unit suites near the 400-600 line range.

Problem:

Some routing unit tests look like branch inventories instead of behavior
contracts.

Direction:

- Keep representative happy path, likely failure mode, and meaningful boundary.
- Delete duplicate constant-variation cases unless they document a distinct
  production incident or contract.
- Prefer table tests only when the table itself is the durable contract.

## Test Adapter Guidance

The high-value pattern from this cleanup is shared test adapters with role-named
introspection:

- `ConversationWorkQueueTestAdapter` for durable queue send behavior.
- Slack HTTP/MSW fixtures for Slack request/response contracts.
- Package and egress fixtures for temp filesystem and proxy harness setup.

The anti-pattern is a behavior test that invents local stores, queue fakes,
runtime mocks, and delivery mocks in the same file. That usually means the test
belongs in integration/component/eval, or the production seam is too broad.

## Completion Criteria For The Next Pass

- No mixed-contract test file above roughly 600 lines unless it is a deliberate
  table of local deterministic cases.
- No integration tests with module mocks.
- No behavior tests asserting ordinary logs, spans, or prompt prose.
- New recurring fakes become shared fixtures or adapters before their third use.
- Runtime response tests move away from broad unit mocks toward component
  harnesses and evals.
