# OpenSpec Backfill Guide

## Canonical Ownership

During the backfill, repository-root `specs/*.md` remain the canonical specs that agents must read for current behavior. OpenSpec backfill changes under `openspec/changes/*` are proposed capability contracts until they are applied and archived.

Accepted baseline capability specs should be promoted deliberately:

1. Keep implementation contracts discoverable from `specs/index.md`.
2. Keep root `AGENTS.md` known-spec pointers aligned with accepted canonical specs.
3. Do not archive, delete, or rewrite an existing canonical spec until the backfilled capability has equivalent or narrower ownership, reviewed open questions, and a verification map.
4. When OpenSpec and `specs/` content overlap, record which document is authoritative before marking the backfill complete.

## Backfill Workflow

Every capability backfill uses the same sequence:

1. Complete [worksheet-template.md](./worksheet-template.md).
2. Complete [verification-map-template.md](./verification-map-template.md).
3. Draft OpenSpec requirements and scenarios.
4. Record unresolved behavior as open questions instead of requirements.
5. Update discovery/index pointers only after the capability is accepted.
6. Validate the OpenSpec change and run mapped verification.

## Acceptance Checklist

A backfilled capability is complete only when:

- Current-source inventory covers code, canonical specs, tests/evals, fixtures, and relevant package docs.
- Prior art has been reviewed, or the worksheet explains why external prior art is not applicable.
- Implemented behavior and intended behavior are separated.
- Undefined behavior and open questions are recorded.
- Requirements use OpenSpec `SHALL`/`MUST` language and every requirement has at least one `#### Scenario`.
- Verification map classifies each scenario as unit, integration, eval, manual, or intentionally unverified with rationale.
- Existing eval/test files are treated as coverage inventory and marked keep, rename, split, move, replace, or delete where relevant.
- `specs/index.md`, root `AGENTS.md`, and related-spec links are updated when the capability becomes canonical.
- `openspec validate <change>` passes.
- Verification commands from the map have been run or explicitly deferred with a reason.
