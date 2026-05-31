# Backfill Eval Testing Specs

## Why

Evals are Junior's integration-style layer for agent-facing behavior. They run realistic Slack conversation scenarios through the harness and judge user-visible outcomes. Existing prose specs and README guidance are strong, but OpenSpec needs a canonical `eval-testing` capability.

## What Changes

- Add `eval-testing` requirements for eval scope, harness execution, rubric shape, prompt realism, allowed overrides, replay/credential behavior, boundaries, naming, and verification.

## Out of Scope

- Migrating or renaming existing eval cases.
- Defining the eval taxonomy migration map.
- Low-level Slack HTTP contract testing.

## Impact

Eval authors get a spec-backed contract for what belongs in evals and how to write maintainable rubrics.
