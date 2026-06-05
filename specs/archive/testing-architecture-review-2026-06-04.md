# Testing Architecture Review, 2026-06-04

## Metadata

- Created: 2026-06-04
- Last Edited: 2026-06-05

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
  `tests/component/sandbox/executor-snapshots.test.ts`.
- Split sandbox executor bash execution, timeout, abort, env, and credential
  egress coverage into `tests/component/sandbox/executor-bash.test.ts`.
- Split sandbox executor file-tool, cached executor, keepalive, and virtual
  skill-file coverage into `tests/component/sandbox/executor-tools.test.ts`.
- Moved the remaining sandbox executor lifecycle/session-manager coverage into
  `tests/component/sandbox/executor-lifecycle.test.ts`.
- Extracted shared `generateAssistantReply` runtime mocks into
  `tests/fixtures/respond-runtime.ts` for the provider-retry and timeout-resume
  suites, leaving each file focused on its fake Pi agent behavior and
  assertions.
- Extracted the progressive MCP loading runtime harness into
  `tests/fixtures/respond-mcp-progressive-loading.ts`, then split the scenarios
  into focused MCP skill-loading, session-context, and auth-resume suites.
- Extracted a CLI check repository fixture into `tests/fixtures/check-cli.ts`
  and split `check-cli.test.ts` into app-config, deployment-config, package,
  plugin-manifest, and skill validation suites.
- Extracted subscribed-thread routing input defaults into
  `tests/fixtures/subscribed-decision.ts` and split the subscribed-decision
  suite into preflight, short-circuit, and classifier outcome files.
- Extracted turn-session record setup/cleanup into
  `tests/fixtures/turn-session-record.ts` and split the service suite by pause,
  running, completed, and projection persistence contracts.
- Extracted Slack scheduler tool setup into
  `tests/fixtures/slack-schedule-tools.ts` and split the broad integration
  suite by create/default, validation, update/ownership, run/claiming, and
  execution-mode contracts.
- Moved the remaining Slack tool/action integration suites under
  `tests/integration/slack/` and dropped redundant `slack-` filename prefixes
  so the root integration directory no longer mixes feature ownership.
- Pruned duplicated Slack tool assertions for user profile fields and thread
  read endpoint selection while preserving those contracts in stronger
  neighboring cases.
- Extracted MCP OAuth callback setup into
  `tests/fixtures/mcp-oauth-callback-route.ts` and split callback coverage by
  route guards, persisted resume context, stale/missing resume guards, and
  resumed file delivery contracts.
- Extracted MCP auth Slack runtime setup into
  `tests/fixtures/mcp-auth-runtime-slack.ts` and split runtime coverage by
  mention resume, subscribed-thread parking, and direct-provider activation
  contracts.
- Moved OAuth callback route/resume suites under `tests/integration/oauth/`
  and moved MCP auth runtime suites under `tests/integration/slack/` so
  top-level integration files no longer encode feature ownership in prefixes.
- Split the MCP OAuth thread-lock refresh contract into
  `tests/integration/oauth/mcp-callback-resume-lock.test.ts`, matching the
  generic OAuth callback suite's context-vs-lock boundary.
- Extracted generic OAuth callback setup into
  `tests/fixtures/oauth-callback-route.ts` and split callback coverage by app
  home publication, resume context, thread-lock freshness, and
  abandoned-session guards.
- Moved the broad mocked OAuth callback handler unit suite into real route
  integration suites for guard HTML, provider errors, and token exchange, with
  token request serialization kept as a small pure unit suite.
- Moved timeout resume runner behavior out of a mocked handler unit suite and
  into component runtime suites backed by an explicit `resumeSlackTurn` test
  port.
- Extracted runtime dependency snapshot mocks into
  `tests/fixtures/runtime-dependency-snapshots.ts` and split cache/rebuild,
  install/build, and instrumentation contracts into focused unit suites.
- Extracted Slack timeout-resume setup into
  `tests/fixtures/turn-resume-slack.ts` and split integration coverage by
  resumed reply delivery, durable continuation scheduling, and file delivery.
- Extracted OAuth resume Slack setup into
  `tests/fixtures/oauth-resume-slack.ts` and split integration coverage by
  delivery, chunking, failure markers, and file delivery contracts.
- Moved Slack-visible OAuth/turn resume suites under
  `tests/integration/slack/` and pruned the duplicated timeout-continuation
  case so the integration layer keeps one representative durable handoff path.
- Added an explicit `agentFactory` port to `generateAssistantReply` and moved
  provider-retry/cooperative-yield and timeout-resume orchestration coverage
  into component runtime suites backed by `tests/fixtures/respond-agent.ts`
  instead of a Pi Agent module mock.
- Removed the broad `tests/fixtures/respond-runtime.ts` module-mock harness;
  respond component suites now use explicit runtime env setup, scripted agents,
  scripted sandbox execution, and preselected thinking levels.
- Added an explicit `sandboxExecutorFactory` port to `generateAssistantReply`
  and moved lazy sandbox boot/metadata coverage into a component runtime suite
  backed by real skill discovery plus `tests/fixtures/respond-sandbox.ts`.
- Moved respond startup error handling into component runtime coverage backed by
  the sandbox executor port, removing the direct skills-module mock from that
  error-path suite.
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

- `packages/junior/tests/component/runtime/respond-mcp-auth-resume.test.ts`
- `packages/junior/tests/component/runtime/respond-mcp-session-context.test.ts`
- `packages/junior/tests/component/runtime/respond-mcp-skill-loading.test.ts`
- `packages/junior/tests/component/runtime/respond-lazy-sandbox.test.ts`
- `packages/junior/tests/component/runtime/respond-startup-error.test.ts`
- `packages/junior/tests/component/runtime/respond-timeout-resume.test.ts`
- `packages/junior/tests/component/runtime/respond-provider-retry.test.ts`

Problem:

These tests mock a broad runtime surface to drive `generateAssistantReply`-style
behavior. They often prove multi-module orchestration, prompt/tool/runtime
handoffs, auth pauses, or resume behavior from a unit layer.

`respond-lazy-sandbox.test.ts` now lives under `tests/component/runtime`, uses a
scripted sandbox executor factory instead of a sandbox module mock, and reads a
temporary skill from disk instead of mocking the skills module. It still proves
the `generateAssistantReply` orchestration contract that sandbox boot is lazy
and sandbox metadata survives failed turns.

`respond-startup-error.test.ts` now proves startup failure propagation and
sandbox reuse metadata through an explicit failing sandbox executor factory
instead of a mocked skills module.

`respond-provider-retry.test.ts` and `respond-timeout-resume.test.ts` now live
under `tests/component/runtime` and drive Pi behavior through the explicit
`agentFactory` port with shared deterministic import-time env setup and
preselected thinking levels instead of the old broad respond runtime fixture.

The progressive MCP loading coverage now lives under `tests/component/runtime`.
It drives `generateAssistantReply` through explicit local ports for the Pi
agent, MCP client, sandbox executor, and selected thinking level instead of
mocking those runtime modules. The tests also stopped asserting fake prompt
prose and now check durable session/auth behavior plus structural runtime
context boundaries.

Remaining debt in this family is narrower: the shared fixture still stubs plugin
registry, skill discovery, and OAuth delivery modules because those are separate
composition boundaries. The next pass should either replace those with local
fixture providers or delete low-signal cases already covered by higher-fidelity
Slack/auth integration tests.

Direction:

- Move deterministic turn orchestration into component tests backed by explicit
  local ports for Pi events, tool execution, sandbox acquisition, auth parking,
  and session records.
- Keep only small pure helpers in unit suites.
- Use integration tests for user-visible Slack/runtime delivery effects.
- Use evals when the contract depends on natural-language interpretation.

### 2. Sandbox Executor Harness

File:

- `packages/junior/tests/component/sandbox/bash-tool-adapter.test.ts`
- `packages/junior/tests/component/sandbox/executor-lifecycle.test.ts`
- `packages/junior/tests/component/sandbox/executor-bash.test.ts`
- `packages/junior/tests/component/sandbox/executor-tools.test.ts`
- `packages/junior/tests/component/sandbox/executor-snapshots.test.ts`

Problem:

The sandbox executor coverage now lives under `tests/component/sandbox` because
it exercises real executor/session-manager orchestration with fake Vercel
Sandbox, bash-tool, plugin registry, config, and dependency snapshot
boundaries. The shared fixture now supplies the default bash-tool facade so
individual cases only override file-tool behavior when that behavior is the
contract under test.

The remaining risk is fixture breadth: lifecycle, egress policy, bash command
execution, virtual skill files, file-tool errors, bash-tool adapter shape, and
runtime dependency snapshots still share one fixture with several module mocks.
That is acceptable for component coverage, but future changes should avoid
adding more responsibilities to the fixture.

Direction:

- Keep growing the dedicated sandbox executor fixture only for repeated
  sandbox/session-manager boundaries.
- Keep lifecycle, bash execution, tool/file behavior, adapter contract, and
  snapshot suites separate.
- Longer term, consider smaller production ports for sandbox boot, bash command
  execution, file tools, and snapshot resolution so tests do not need one
  enormous mock harness.

### 3. Large Slack/OAuth Integration Suites

Files:

- `packages/junior/tests/integration/slack/schedule-create-tools.test.ts`
- `packages/junior/tests/integration/slack/schedule-validation-tools.test.ts`
- `packages/junior/tests/integration/slack/schedule-update-tools.test.ts`
- `packages/junior/tests/integration/slack/schedule-run-tools.test.ts`
- `packages/junior/tests/integration/slack/schedule-execution-mode.test.ts`
- `packages/junior/tests/integration/oauth/mcp-callback-resume-context.test.ts`
- `packages/junior/tests/integration/oauth/mcp-callback-resume-lock.test.ts`
- `packages/junior/tests/integration/oauth/mcp-callback-resume-guards.test.ts`
- `packages/junior/tests/integration/oauth/mcp-callback-file-delivery.test.ts`
- `packages/junior/tests/integration/oauth/mcp-callback-route-guards.test.ts`
- `packages/junior/tests/integration/slack/mcp-auth-runtime-mention-resume.test.ts`
- `packages/junior/tests/integration/slack/mcp-auth-runtime-subscribed-parking.test.ts`
- `packages/junior/tests/integration/slack/mcp-auth-runtime-direct-provider.test.ts`
- `packages/junior/tests/integration/oauth/callback-app-home.test.ts`
- `packages/junior/tests/integration/oauth/callback-route-guards.test.ts`
- `packages/junior/tests/integration/oauth/callback-route-provider-errors.test.ts`
- `packages/junior/tests/integration/oauth/callback-route-token.test.ts`
- `packages/junior/tests/integration/oauth/callback-resume-context.test.ts`
- `packages/junior/tests/integration/oauth/callback-resume-lock.test.ts`
- `packages/junior/tests/integration/oauth/callback-resume-guards.test.ts`
- `packages/junior/tests/integration/slack/oauth-resume-slack-delivery.test.ts`
- `packages/junior/tests/integration/slack/oauth-resume-slack-chunking.test.ts`
- `packages/junior/tests/integration/slack/oauth-resume-slack-failure-markers.test.ts`
- `packages/junior/tests/integration/slack/oauth-resume-slack-file-delivery.test.ts`
- `packages/junior/tests/integration/slack/turn-resume-slack-delivery.test.ts`
- `packages/junior/tests/integration/slack/turn-resume-slack-continuation.test.ts`
- `packages/junior/tests/integration/slack/turn-resume-slack-file-delivery.test.ts`

Problem:

These are often in the right layer, but several files mix route contract,
state persistence, Slack delivery, retries, and continuation behavior.

Direction:

- Keep them integration-level when they exercise real product wiring.
- Split by external contract: callback validation, Slack-visible delivery,
  persisted auth/session state, retry behavior, and resumed turn behavior.
- Avoid payload-order assertions outside dedicated transport-contract files.

### 4. CLI Check Suite

Files:

- `packages/junior/tests/unit/cli/check-cli-app-config.test.ts`
- `packages/junior/tests/unit/cli/check-cli-deployment-config.test.ts`
- `packages/junior/tests/unit/cli/check-cli-packages.test.ts`
- `packages/junior/tests/unit/cli/check-cli-plugin-manifests.test.ts`
- `packages/junior/tests/unit/cli/check-cli-skills.test.ts`

Problem:

The suite is mostly legitimate unit/CLI validation. It now uses a shared fixture
and focused files by validation family. The remaining risk is over-testing
similar config-file variants as the CLI surface grows.

Direction:

- Keep future checks grouped by validation family instead of re-growing a
  catch-all CLI file.
- Reuse the CLI repo fixture for temp filesystem setup and captured logger
  output.
- Delete duplicate constant-variation cases unless they represent a distinct
  CLI contract.

### 5. Routing Decision Tables

Files:

- `packages/junior/tests/unit/routing/subscribed-preflight-decision.test.ts`
- `packages/junior/tests/unit/routing/subscribed-short-circuit-decision.test.ts`
- `packages/junior/tests/unit/routing/subscribed-classifier-decision.test.ts`
- Other large routing/service unit suites near the 400-600 line range.

Problem:

Some routing unit tests look like branch inventories instead of behavior
contracts. The subscribed-thread routing suite is now organized by decision
stage, but the broader risk still applies to other large routing/service files.

The turn-session record suite is also split by persistence contract. It remains
unit-level because it is deterministic state adapter behavior, but future
changes should keep pause, running, completed, and projection behavior separate.

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
