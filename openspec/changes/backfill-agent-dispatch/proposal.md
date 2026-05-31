# Backfill Agent Dispatch Specs

## Why

The codebase has an internal `chat/agent-dispatch/*` module in addition to the product-facing `trusted-plugin-dispatch` capability. The prior backfill for `trusted-plugin-dispatch` already specifies almost all dispatch behavior, including plugin API, validation, storage, signing, recovery, runner execution, Slack delivery, timeout continuation, and authorization blocking.

This backfill exists to make the ownership boundary explicit so future contributors do not create a second overlapping dispatch capability. `agent-dispatch` is the internal implementation boundary for core-owned background agent slices; the externally meaningful contract remains `trusted-plugin-dispatch`.

## What Changes

- Add an `agent-dispatch` ownership spec that defines the internal module boundary and non-overlap with `trusted-plugin-dispatch`.
- Specify the internal invariants that are not a separate product API:
  - callbacks are verified before runner execution
  - runner uses stable dispatch conversation and turn ids
  - dispatch state is hidden behind plugin projections
  - queued/interactive Slack message dispatch remains separate from agent dispatch
- Record current evidence, verification coverage, and open questions.

## Out of Scope

- Repeating every requirement already owned by `trusted-plugin-dispatch`.
- Creating a second plugin-facing dispatch API.
- Changing queue-backed Slack message delivery.
- Implementing dispatch changes.

## Impact

Dispatch ownership becomes clearer: product behavior changes should update `trusted-plugin-dispatch`, while internal module refactors should preserve the `agent-dispatch` invariants in this spec.
