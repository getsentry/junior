# Testing Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-22

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated test fixture path references to repo-root paths under `packages/junior/`.
- 2026-03-04: Clarified layering: baseline behavior coverage belongs in integration tests; unit tests are for local regressions and edge cases.
- 2026-03-04: Elevated layer selection to mandatory policy before adding/updating tests.
- 2026-03-17: Clarified that behavior tests should not assert internal logs or telemetry unless instrumentation is the contract under test.
- 2026-03-22: Defined the default layer preference order: evals first for LLM-dependent behavior, integration next for real wiring without the LLM, unit last for local invariants only.

## Purpose

This index defines the project testing taxonomy and the contract between test layers.
Use this file as the source of truth for where a test belongs and what it is allowed to mock.

## Default Preference Order

Choose the highest-fidelity layer that matches the contract:

1. Use evals for end-to-end product behavior when model behavior, continuity, or natural-language interpretation is part of the contract.
2. Use integration tests when you need real runtime wiring and Slack-facing behavior but do not need the LLM in the loop.
3. Use unit tests only for small local invariants, parsing/normalization, retry/state logic, and regression edges that do not need real runtime wiring.

Do not default to unit tests for runtime behavior just because they are easier to write.

## Test Layers

| Layer               | Primary Goal                                           | Scope                                                                    | Allowed Substitutions                                         | Disallowed                                                                                                |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Unit                | Validate local regressions/edge-case invariants        | Single module/function and tight collaborators                           | Local stubs/mocks (`vi.mock`, fakes)                          | Baseline behavior coverage, Slack HTTP contract assertions, and end-to-end conversational quality scoring |
| Integration         | Validate baseline runtime behavior and Slack contracts | Real app wiring + Slack-facing behavior + persistence/routing boundaries | Deterministic fake agent at the agent boundary only           | Runtime module/function mocks for behavior paths                                                          |
| Eval (E2E Behavior) | Validate conversational outcomes                       | End-to-end harnessed conversation flows scored by judge criteria         | Case-level behavior fixtures and controlled environment flags | Low-level HTTP payload-shape assertions and internals-only checks                                         |

## Canonical Specs

- Unit rules: `specs/testing/unit-spec.md`
- Integration rules: `specs/testing/integration-spec.md`
- Evals rules: `specs/testing/evals-spec.md`
- Slack HTTP fixture/MSW details: `specs/testing/slack-mocking-spec.md`
- Harness tool-targeting rules: `specs/harness-tool-context-spec.md`

## Shared Rules Across All Layers

Layer selection is mandatory: classify the test contract first and choose `unit` vs `integration` vs `eval` before writing assertions.

1. Tests must be deterministic and isolated.
2. Slack network access is blocked in tests; use MSW fixtures for Slack HTTP.
3. Use centralized fixtures/factories (`packages/junior/tests/fixtures/slack/*`) over ad-hoc payload literals when available.
4. Prefer asserting user-visible behavior and external contracts over implementation details.
5. Keep test names descriptive of outcomes, not implementation mechanics.
6. Do not over-test: cover representative, high-risk scenarios for each contract, not every theoretical permutation.
7. Prefer one focused assertion path per behavior contract; add more cases only when they validate a distinct failure mode.
8. Workflow behavior integration tests should execute real runtime paths and only substitute deterministic fake agent output at the agent boundary.
9. Do not assert internal observability emission (`logInfo`, `logWarn`, spans, trace attributes) in behavior tests unless instrumentation output is itself the contract under test.

## Coverage Budget (Avoid Over-Testing)

Over-testing means adding low-signal tests that duplicate the same contract with different constants, mirror implementation branches without new behavior risk, or assert internal details that users do not observe.

This includes logger calls and trace metadata for ordinary behavior paths. Those assertions belong only in instrumentation-focused tests or surfaces where the emitted output is the product (for example CLI output).

Use this practical budget:

1. Happy path for the contract.
2. One high-likelihood failure mode (or policy guardrail).
3. One boundary scenario only when it has prior incident history or meaningful production risk.

If a proposed test does not add a new contract guarantee, do not add it.

## Layer Selection Guide

This section is mandatory policy, not guidance.

Default order:

1. Eval
2. Integration
3. Unit

Use unit tests when:

- You are validating retry math, parsing/normalization logic, pure state transitions, and regression/edge-case handling in local logic.
- The contract is not baseline runtime behavior.
- Running the real runtime path would add indirection without increasing confidence.

Use integration tests when:

- You need baseline confidence in Slack event handling, routing, runtime orchestration, and emitted Slack-side effects.
- You can keep runtime wiring real and only control the agent output deterministically.
- The contract does not depend on the model making the right conversational choice.

Use evals when:

- You need conversation-quality validation over multi-turn flows and outcome scoring.
- The contract depends on model interpretation, continuity, routing by natural language, or other user-visible LLM behavior.

## Enforcement

`pnpm run test:slack-boundary` enforces major boundary rules:

- Eval files cannot import Slack contract internals.
- Integration behavior tests cannot use runtime module mocks.

See `scripts/check-slack-test-boundary.mjs`.
