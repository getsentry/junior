# Backfill `trusted-plugin-heartbeat`

## Why

Trusted plugin heartbeat is the pulse that lets host-registered plugins perform bounded background reconciliation and dispatch core-owned agent work. It must not expose raw routes, Slack clients, request objects, unrestricted state, or agent internals. Existing prose and implementation already describe the model, but the baseline needs OpenSpec requirements verified against code and tests.

## What

- Backfill an OpenSpec capability for `trusted-plugin-heartbeat`.
- Inventory heartbeat prose, plugin API types, heartbeat handler, trusted plugin registration, heartbeat context, plugin state/logger, recovery ordering, scheduler integration, and tests.
- Define normative requirements for:
  - trusted-only heartbeat availability
  - core-owned heartbeat endpoint authentication
  - heartbeat execution ordering
  - bounded plugin heartbeat invocation
  - heartbeat context shape and capability boundaries
  - namespaced plugin state
  - plugin logger
  - plugin failure isolation
  - tool-registration boundary pointers
  - verification taxonomy
- Record undefined behavior and gaps without changing implementation.

## Impact

- Canonical capability: `trusted-plugin-heartbeat`
- Existing prose input: `specs/trusted-plugin-heartbeat.md`
- Related capabilities:
  - `plugin-runtime`
  - `trusted-plugin-dispatch`
  - `scheduler`
  - `slack-tools`
  - `security-policy`

## Non-Goals

- Dispatch record state machine details.
- Scheduler task recurrence/domain semantics.
- Trusted plugin manifest/package discovery.
- Defining raw Slack APIs for plugins.
- Changing endpoint auth or plugin invocation behavior.
