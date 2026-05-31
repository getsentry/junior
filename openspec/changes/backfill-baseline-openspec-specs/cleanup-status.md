# Backfill Cleanup Status

## Canonical Index

- Updated `specs/index.md` with broader ownership coverage for chat, auth, plugins, tools, observability, and testing.
- Kept existing `specs/*.md` as canonical until individual OpenSpec backfills are accepted and archived.
- Added an explicit note that active `openspec/changes/backfill-*` artifacts are review artifacts, not canonical archived specs.

## Agent Pointers

- Updated `AGENTS.md` known-spec pointers for currently listed canonical docs that were missing from the root known-spec list.

## Superseded Prose

- No canonical prose was archived in this baseline pass.
- Reason: the individual OpenSpec backfills have not been accepted/archived into `openspec/specs/` yet.
- On acceptance of each backfill, narrow or archive overlapping prose and leave rationale/index content in `specs/*.md` where useful.

## Validation

- `openspec validate --all --strict` passed for 43 items.

## Verification Commands

- This pass is spec-only baseline work. It did not run all product unit/integration/eval commands listed or implied by every verification map.
- Each backfill includes a `verification-map.md` recording current coverage, keep/split/move/add decisions, gaps, and deferred open questions.
- Runtime/product verification should be run when implementing behavior changes or when accepting a specific backfill as canonical.
