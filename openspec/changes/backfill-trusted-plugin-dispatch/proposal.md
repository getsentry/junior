# Backfill `trusted-plugin-dispatch`

## Why

Trusted plugin dispatch is the durable primitive that lets host-registered plugins ask Junior core to run autonomous agent work outside an interactive Slack turn. It touches plugin API shape, heartbeat contexts, durable dispatch records, internal callback signing, state locks, system actor execution, Slack delivery, timeout continuation, auth blocking, recovery, and scheduler integration.

The existing prose spec is strong, but the OpenSpec baseline should verify it against implementation and tests, and should separate dispatch from generic plugin runtime, scheduler semantics, and heartbeat invocation.

## What

- Backfill an OpenSpec capability for `trusted-plugin-dispatch`.
- Inventory the existing dispatch spec, plugin API types, dispatch context/store/signing/validation/runner/heartbeat code, internal handler, scheduler integration tests, and runner tests.
- Review prior art for at-least-once callbacks, idempotency keys, signed internal callbacks, and Slack message destinations.
- Define normative requirements for:
  - plugin-facing dispatch API and result projection
  - dispatch input validation
  - idempotent durable record creation
  - plugin-scoped lookup projection
  - internal callback signing and endpoint behavior
  - incomplete-dispatch recovery
  - dispatch locking and version claims
  - system actor runner context
  - Slack delivery and duplicate suppression
  - timeout continuation
  - authorization blocking
  - delegated credential subjects
  - limits and verification taxonomy
- Record undefined behavior and implementation gaps.

## Impact

- Canonical capability: `trusted-plugin-dispatch`
- Existing prose input: `specs/trusted-plugin-dispatch.md`
- Related capabilities:
  - `trusted-plugin-heartbeat`
  - `agent-dispatch`
  - `scheduler`
  - `agent-session-resumability`
  - `slack-agent-delivery`
  - `credential-injection`
  - `security-policy`

## Non-Goals

- Redefining scheduler task/run semantics.
- Redefining trusted plugin heartbeat authentication.
- Replacing the homegrown callback loop with Vercel Queues or another queue.
- Defining interactive Slack turn handling.
- Changing implementation.
