# Model Handoff

## Why

Junior cannot safely change the provider model inside an existing Pi history.
Advanced requests need a one-way upgrade that preserves the user-visible
conversation, workspace, sandbox, tools, credentials, delivery, and recovery
semantics while starting the stronger model from a bounded context window.

## What Changes

- Add an argument-free, standard-only `handoff` control tool.
- Add `AI_ADVANCED_MODEL`, defaulting to `openai/gpt-5.6-sol`.
- Reuse context summarization to create a summary-only replacement projection.
- Bind every replacement projection to `standard` or `advanced`; handoff selects
  advanced, while later compaction and rollback inherit the current binding.
- Swap Pi's model, messages, and tool set at the next-turn boundary in the same
  run; only `handoff` is removed after success.
- Preserve generic child-conversation and subagent history storage, but expose
  no advisor or delegate runtime. A generic subagent is a future design.

## Non-Goals

- Model downgrade, arbitrary provider model ids, or repeated handoff.
- A successor conversation, task, workspace, or sandbox.
- Designing or shipping a generic subagent runtime.
- Removing historical advisor decoding, migration, reporting, or retention.

## Verification

- Component tests cover summary persistence, failure atomicity, and inherited
  model bindings across compaction and rollback.
- Integration tests cover same-turn model swap, future-turn advanced ownership,
  mixed-tool rejection, yield, and hard-worker recovery.
- A distinct-model, two-turn eval proves one handoff, two replies, advanced
  follow-up execution, and reuse of the same workspace file.
