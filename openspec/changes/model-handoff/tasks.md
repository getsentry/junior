# Tasks

## Contract

- [x] Add canonical model-handoff, compaction, storage, resumability, prompt,
      telemetry, and configuration documentation.
- [x] Preserve generic subagent storage while removing advisor and delegate
      runtime surfaces.

## Runtime

- [x] Add reserved standard/handoff profiles, custom named profile resolution,
      and a `gpt-5.6-sol` default handoff target.
- [x] Add standalone profile-selecting `handoff` and mixed-batch rejection.
- [x] Write a summary-only profile-bound projection atomically.
- [x] Swap model/context/tools through Pi `prepareNextTurn` in the same run.
- [x] Remove `handoff` after success and preserve every normal main-agent tool.
- [x] Preserve provisional text, usage aggregation, yield, timeout, auth,
      steering, recovery, workspace, and sandbox behavior across the swap.
- [x] Make compaction and rollback inherit the current projection binding.
- [x] Record explicit initial epochs and audit-only resolved model ids on every
      new projection.
- [x] Remove the all-history handoff scan.

## Verification

- [x] Component: handoff success/failure and inherited projection binding.
- [x] Integration: same-turn and future-turn distinct-model execution.
- [x] Integration: mixed batches, post-handoff yield, and hard-worker recovery.
- [x] Eval: distinct-model two-turn coding task with one handoff, two replies,
      selected-model follow-up steps, and the same workspace file.
- [x] Manual: local CLI calls handoff and answers in the same turn.
