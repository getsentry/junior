## Why

Junior has many useful canonical markdown specs, but OpenSpec works best when behavior is organized as capability requirements with concrete scenarios and explicit verification. Backfilling a baseline OpenSpec spec set will make future changes easier to propose, apply, validate, and archive without depending on historical doc names or legacy eval file boundaries.

## What Changes

- Add a backfill program spec that defines how each baseline capability spec must be created.
- Create an ordered task plan for backfilling every baseline spec area, including prior-art review, implementation inspection, undefined behavior/open questions, OpenSpec requirements/scenarios, and verification mapping.
- Treat existing evals and tests as evidence to audit, not as authoritative taxonomy; tasks include deciding whether each eval/test should be kept, renamed, split, moved, or replaced.
- Preserve current canonical `specs/` documents while each capability is backfilled; no existing runtime behavior changes are proposed by this meta-change.

## Capabilities

### New Capabilities

- `openspec-backfill-program`: Defines the process and acceptance criteria for backfilling Junior's baseline capability specs into OpenSpec format.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-baseline-openspec-specs/`.
- Establishes the work queue for future backfill changes covering chat, Slack, agent execution, tools, auth, plugins, scheduler, configuration, testing, observability, CLI, docs, and release packaging.
- Does not modify production code or existing canonical specs directly.
