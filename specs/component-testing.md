# Component Testing Spec

## Metadata

- Created: 2026-06-02
- Last Edited: 2026-06-02

## Intent

Component tests validate deterministic service/runtime contracts that span more
than one module but do not need full product wiring to prove the invariant.

Use this layer when real domain code, memory-backed state, and explicit local
ports give a clearer contract test than either a narrow unit test or a broad
integration test.

## Scope

In scope:

- Durable store and state-machine contracts.
- Queue wake-up, lease, heartbeat, and worker coordination.
- Service orchestration where the dependency boundary is a small injected port.
- Adapter contracts that can be proven with a fake client or MSW without running
  the full Slack/runtime path.
- Persistence behavior using the shared memory state adapter.

## Non-Goals

- Slack-visible behavior, final reply delivery, and Slack HTTP request contracts
  that require real runtime wiring.
- Model-dependent behavior or conversational quality.
- Tests that patch production singletons or module imports to steer a user-visible
  workflow.
- Exhaustive branch coverage for implementation details.

## Substitution Policy

Allowed:

- Fake queue, clock, random-id, callback, and agent-runner ports.
- Shared memory-backed state adapters.
- MSW handlers when the adapter boundary itself is the contract.
- Local spies on explicit injected ports.

Disallowed:

- Broad dependency bags or service locators created only for tests.
- `vi.mock` of runtime modules to force unrelated branches.
- Fake Slack delivery and fake reply execution together to prove a single
  user-visible outcome. Use integration or eval for that.

## Naming and Placement

- Preferred path: `packages/junior/tests/component/**`.
- Test titles should name the durable/service outcome, not the implementation
  branch that happens to produce it.
- Keep component files focused by feature or service boundary, for example
  `tests/component/task-execution/*`.

## Required Characteristics

1. Use real domain modules for the contract under test.
2. Keep fake ports explicit, small, and role-named.
3. Assert the externally relevant service result first, then durable state when
   the durable state is part of the contract.
4. Prefer one representative failure or race case per invariant.
5. Do not promote a component test to integration solely to satisfy a coverage
   checklist.
