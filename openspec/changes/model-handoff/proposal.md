# Model Handoff

## Why

Junior cannot safely change the provider model inside an existing Pi history.
Higher-capability requests need a one-way switch that preserves the visible
conversation and runtime environment while starting another model from bounded
context. Hosts also need to name several permitted target profiles without
exposing provider model ids to the agent.

## What Changes

- Add a standard-only terminal `handoff` control tool with an optional named
  profile selected from the host-owned catalog.
- Add the reserved `handoff` profile through `AI_HANDOFF_MODEL`, defaulting to
  `openai/gpt-5.6-sol`, and custom profiles through `AI_MODEL_PROFILES`.
- Reuse context summarization to create a summary-only replacement projection.
- Bind each projection to an authoritative profile and an audit-only resolved
  model id; compaction and rollback inherit the current binding.
- Swap Pi's model, messages, and tool set at the next-turn boundary in the same
  run; only `handoff` is removed after success.
- Preserve generic child-conversation and subagent history storage, but expose
  no advisor or delegate runtime.

## Non-Goals

- Model downgrade, repeated handoff, or model-selected raw provider ids.
- A successor conversation, task, workspace, or sandbox.
- Designing or shipping a generic subagent runtime.
- Removing historical advisor decoding, migration, reporting, or retention.

## Verification

- Component tests cover configuration, summary persistence, failure atomicity,
  and inherited model bindings.
- Integration tests cover default and selected profiles, same-turn model swap,
  future-turn ownership, mixed-tool rejection, yield, and worker recovery.
- A distinct-model two-turn eval proves one handoff, two replies, follow-up
  execution on the selected model, and reuse of the same workspace file.
