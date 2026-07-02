# Component Testing Spec

## Metadata

- Created: 2026-06-02
- Last Edited: 2026-07-02

## Purpose

Component tests cover deterministic service/runtime contracts that cross modules
without needing full product wiring. Layer-selection judgment lives in
`../policies/testing.md`.

## Use For

- Durable stores and state machines.
- Queue wake-up, lease, heartbeat, and worker coordination.
- Service orchestration through small injected ports.
- Adapter contracts where the adapter boundary itself is the contract.

## Mechanics

- Preferred path: `packages/junior/tests/component/**`.
- Use real domain modules for the contract under test.
- Use shared memory-backed state adapters when persistence is involved.
- Fake ports should be explicit, small, and role-named.
- MSW is acceptable when the adapter boundary is the contract.

## Do Not Use For

- Slack-visible behavior or final reply delivery.
- Model-dependent behavior.
- Tests that patch production singletons or runtime imports to steer product
  behavior.
