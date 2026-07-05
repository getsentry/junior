# Testing Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-07-02

## Purpose

Testing judgment lives in `../policies/testing.md`. Use this file only to pick
the repo test layer and find the harness docs.

## Layer Choice

1. Use `eval` when model interpretation, continuity, tool choice, routing, or
   reply quality is the behavior.
2. Use `integration` when product/runtime behavior crosses real wiring,
   persistence, Slack delivery, auth resume, API, or handler boundaries.
3. Use `component` when a deterministic service/runtime contract crosses
   modules but full product wiring is unnecessary.
4. Use `unit` only for local deterministic logic and algorithms.

Default to the highest deterministic layer that proves the contract. Do not add
lower-layer duplicate coverage when a higher-fidelity test owns the behavior.
For Slack tools, validate the tool's transport behavior, outbound API payloads,
and attachment serialization outside the agent loop with integration tests and
Slack outbound mocks. Use evals to prove the agent chooses the correct tool,
target, and final-reply behavior from natural-language context.

## Layer References

- Unit mechanics: `./unit-testing.md`
- Component mechanics: `./component-testing.md`
- Integration mechanics: `./integration-testing.md`
- Eval mechanics: `./eval-testing.md`
- Slack MSW and fixtures: `./slack-http-mocking.md`
- Harness tool targeting: `./harness-tool-context.md`

## Commands

- Unit/component/integration file:
  `pnpm --filter @sentry/junior exec vitest run tests/path/file.test.ts`
- Eval file:
  `pnpm --filter @sentry/junior-evals evals path/to/eval.eval.ts`

## Enforcement

`pnpm lint` enforces major Slack behavior-test boundaries, including:

- Eval files cannot import Slack contract internals.
- Integration behavior tests cannot use runtime module mocks.

See `ast-grep/rules/` for the mechanical checks.
