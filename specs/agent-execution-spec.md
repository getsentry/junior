# Agent Execution Discipline Spec

## Metadata

- Created: 2026-03-04
- Last Edited: 2026-03-04

## Changelog

- 2026-03-04: Initial spec defining the Codex execution rubric and completion gates.

## Status

Active

## Purpose

Define a mandatory execution rubric for coding agents so implementation work is planned, contract-driven, and verifiable.

## Scope

- Assistant-driven implementation tasks in this repository.
- Turn-level planning, execution, verification, and handoff behavior.
- Contract checks against canonical specs and skill instructions.

## Non-Goals

- Replacing language- or framework-specific coding standards.
- Defining CI pipeline topology or branch protection policy.

## Contracts

### 1. Contract-First Start

Before editing code, the agent MUST read the most relevant local contracts:
- Root `AGENTS.md`.
- Applicable canonical specs under `specs/`.
- Applicable `SKILL.md` files when a skill-triggered task is in scope.

The agent MUST derive and preserve explicit invariants from these sources during implementation.

### 2. Explicit Execution Plan

For non-trivial tasks, the agent MUST maintain a concrete sequence:
1. Discover current behavior and constraints.
2. Implement minimal end-to-end slice.
3. Verify with targeted checks.
4. Summarize outcomes, risks, and next actions.

For larger tasks, the plan should be maintained as a living artifact in-repo when practical.

### 3. Vertical Slice Implementation

The first implementation pass SHOULD establish the smallest working vertical path before broad refactors.

### 4. Assumption Falsification

Before and during edits, the agent MUST test high-risk assumptions with the narrowest deterministic check available (focused test run, file-scoped search, or direct behavior check).

### 5. Repository Pattern Reuse

The agent MUST prefer established local patterns over novel abstractions when both satisfy requirements:
- Existing architecture seams and naming patterns.
- Existing logging/tracing semantics (`specs/logging/*`).
- Existing testing layer boundaries (`specs/testing/*`).

### 6. Change Legibility

Changes SHOULD optimize for future maintainability and agent reruns:
- Keep diffs localized and intention-revealing.
- Use concise comments only where reasoning is non-obvious.
- Update canonical specs/instructions when behavior contracts change.

### 7. Completion Gates

A task is not complete until all applicable gates pass:
1. Build/typecheck gate for changed surface area.
2. Targeted tests for changed behavior contracts.
3. Contract drift check (specs/instructions updated if behavior changed).
4. Explicit handoff notes for residual risks or unverified paths.

## Failure Model

Common process failures and required correction:
1. Editing before reading contracts:
   - Stop and reconcile implementation against relevant contracts.
2. Broad refactor without a working vertical slice:
   - Reduce scope and land a narrow working path first.
3. Assertions without verification evidence:
   - Run focused checks and report concrete results.
4. Behavior changes without spec/doc updates:
   - Update canonical specs and instruction references in the same change.

## Observability

When agent turn diagnostics are available, execution SHOULD record:
- What contract sources were consulted.
- What verification commands were run.
- Whether completion gates passed or were deferred.

If diagnostics are unavailable, this information MUST be captured in the final handoff summary.

## Verification

Compliance indicators:
1. PR/task summary cites consulted spec/instruction sources when behavior changes are non-trivial.
2. Verification section lists concrete commands run and outcomes.
3. Canonical spec references are updated when behavior contracts change.

## Related Specs

- `./index.md`
- `./harness-agent-spec.md`
- `./harness-tool-context-spec.md`
- `./testing/index.md`
- `./logging/index.md`
