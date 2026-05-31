# Backfill Testing Specs

## Why

Junior has a mature testing taxonomy in prose specs, package scripts, Vitest configs, MSW fixtures, eval harnesses, and boundary checks. The baseline OpenSpec set needs a canonical `testing` capability that defines the top-level layer-selection contract before narrower unit, integration, eval, and Slack HTTP mocking backfills refine each layer.

## What Changes

- Add a `testing` OpenSpec baseline for:
  - mandatory layer selection;
  - unit vs integration vs eval ownership;
  - external HTTP isolation;
  - Slack/MSW fixture expectations;
  - mocking confidence rules;
  - over-testing budget;
  - boundary enforcement scripts;
  - verification command selection.

## Out of Scope

- Re-specifying every rule from unit, integration, eval, and Slack HTTP mocking specs.
- Renaming test files or moving tests.
- Implementing enforcement changes.
- Evaluating every eval case; that belongs to the eval taxonomy migration map.

## Impact

Future test additions can be reviewed against a single OpenSpec taxonomy. The narrower backfills can focus on their layer-specific rules without restating the whole decision tree.
