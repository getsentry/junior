# Backfill Unit Testing Specs

## Why

Unit tests are heavily used across Junior for parsers, transforms, validators, registry helpers, config helpers, local runtime helpers, and small adapter logic. The top-level `testing` spec defines layer selection; this backfill captures the narrower unit-test contract.

## What Changes

- Add a `unit-testing` OpenSpec for deterministic local invariants, allowed mocks, disallowed workflow simulation, placement, fixture use, and verification.
- Record existing coverage patterns and open migration questions for broad legacy unit tests.

## Out of Scope

- Reclassifying existing tests.
- Defining integration/eval rules.
- Adding new enforcement scripts.

## Impact

Unit tests can remain fast and focused while avoiding low-confidence tests that fake product workflows.
