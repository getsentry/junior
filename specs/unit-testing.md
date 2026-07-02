# Unit Testing Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-07-02

## Purpose

Unit tests are for local deterministic logic only. Layer-selection judgment
lives in `../policies/testing.md`.

## Use For

- Parsing and validation helpers.
- Normalization and pure transforms.
- Retry/backoff math.
- Scoring, sorting, dedupe, and other local algorithms.
- Small deterministic adapter wrappers without network contracts.

## Mechanics

- Preferred path: `packages/junior/tests/unit/**`.
- No real network calls.
- Local stubs, spies, and `vi.mock` are allowed when they isolate one local
  invariant.
- Avoid shared runtime state unless the test resets it locally.

## Do Not Use For

- Product/runtime workflows.
- Slack HTTP contracts or Slack-visible behavior.
- Prompt quality, model interpretation, or multi-turn continuity.
- Helper branches already exercised by integration or eval coverage.
