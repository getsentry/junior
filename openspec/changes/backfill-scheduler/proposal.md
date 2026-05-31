# Backfill `scheduler`

## Why

Junior scheduler behavior spans model-facing Slack tools, durable task/run state, calendar recurrence, missed-run policy, trusted plugin heartbeat dispatch, scheduled-run prompt framing, actor/auth rules, and evals for natural-language scheduling. Existing prose in `specs/scheduler.md` is detailed, but the baseline needs OpenSpec requirements verified against implementation and tests.

## What

- Backfill an OpenSpec capability for `scheduler`.
- Inventory scheduler prose, `packages/junior-scheduler`, Slack schedule tool tests, heartbeat integration tests, scheduler evals, and related dispatch/heartbeat specs.
- Review prior art for cron pulses, Slack scheduled messages, and calendar recurrence.
- Define normative requirements for:
  - scheduled task/run data model
  - calendar and recurrence model
  - Slack authoring and management tools
  - destination and credential subject rules
  - storage/indexing and run idempotency
  - missed-run and stale recovery behavior
  - run-now behavior
  - heartbeat dispatch flow and dispatch reconciliation
  - scheduled-run prompt framing
  - actor/auth model
  - verification taxonomy
- Record undefined behavior and gaps without changing runtime code.

## Impact

- Canonical capability: `scheduler`
- Existing prose input: `specs/scheduler.md`
- Related capabilities:
  - `trusted-plugin-heartbeat`
  - `trusted-plugin-dispatch`
  - `slack-tools`
  - `slack-agent-delivery`
  - `agent-prompt`
  - `credential-injection`
  - `eval-testing`

## Non-Goals

- A generic event/webhook rule engine.
- Replacing Junior dispatch with Slack `chat.scheduleMessage`.
- Implementing a workflow engine or SQL scheduler.
- Provider-specific scheduled task semantics.
- Changing scheduler behavior.
