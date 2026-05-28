# Agent Execution Discipline Spec

## Metadata

- Created: 2026-03-04
- Last Edited: 2026-05-28

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
- Existing instrumentation docs (`specs/instrumentation.md`, `specs/logging.md`, `specs/tracing.md`, `specs/otel-semantics.md`).
- Existing testing layer boundaries (`specs/testing.md`, `specs/unit-testing.md`, `specs/integration-testing.md`, `specs/eval-testing.md`).

### 6. Change Legibility

Changes SHOULD optimize for future maintainability and agent reruns:

- Keep diffs localized and intention-revealing.
- Use concise comments only where reasoning is non-obvious.
- Update canonical specs/instructions when behavior contracts change.

### 7. Tool Failure Semantics

Agent-facing tool failures must use the Pi tool-error channel. A tool execution that the model can repair, such as invalid arguments, missing active context, unsupported cadence, or missing target state, must throw `ToolInputError` or another expected tool error so the agent loop records a `toolResult` with `isError=true` and continues.

Tools must not invent sentinel success payloads such as `{ ok: false, error }` for model-repairable failures. Such payloads are ordinary successful tool outputs from the Pi loop's perspective and can cause the model to apologize instead of correcting the tool call. Structured `ok` unions are acceptable inside private helper functions or non-agent HTTP handlers, but not as the final result of an agent tool execution when the operation failed.

### 8. Completion Gates

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
- `./harness-agent.md`
- `./harness-tool-context.md`
- `./testing.md`
- `./instrumentation.md`
