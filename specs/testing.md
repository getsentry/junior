# Testing Spec Index

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-06-02

## Purpose

This index defines the project testing taxonomy and the contract between test layers.
Use this file as the source of truth for where a test belongs and what it is allowed to mock.

## Default Decision Rule

Start from the real product contract, not the easiest seam to mock.

1. Use evals when the contract is agent-facing behavior. Treat evals as the integration-style layer for prompt behavior, natural-language routing, continuity, reply quality, and other outcomes where model interpretation is the contract.
2. Use integration tests when the contract is real product wiring or an external/user-visible boundary: handler behavior, Slack-facing contracts, persistence/routing through production composition, auth resumes, final delivery, and other behavior that does not depend on the model interpreting language correctly.
3. Use component tests for deterministic service/runtime contracts that cross modules but are still best proven through explicit local ports: durable stores, queue wake-up ports, worker state machines, lease/recovery coordination, persistence adapters, and similar orchestration invariants.
4. Use unit tests only for tightly local deterministic logic: parsing, scoring, routing heuristics, retry math, pure transforms, normalization, and similar algorithmic invariants.

Do not default to unit tests for runtime behavior just because they are easier to write. Do not force deterministic service contracts into broad integration tests when a component test would prove the invariant more directly and with fewer fake layers.

## Test Layers

| Layer                 | Primary Goal                                             | Scope                                                                    | Allowed Substitutions                                                           | Disallowed                                                                                            |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unit                  | Validate local deterministic invariants                  | Single module/function and tight collaborators                           | Local stubs/mocks (`vi.mock`, fakes)                                            | Baseline product/runtime behavior, Slack HTTP contract assertions, and conversational quality scoring |
| Component             | Validate deterministic service/runtime contracts         | Real domain modules plus memory state and explicit local ports           | Fake queue/clock/agent-runner ports, memory adapters, MSW for adapter contracts | User-visible Slack delivery flows, model interpretation, broad runtime module mocks                   |
| Integration           | Validate runtime/product behavior and external contracts | Real app wiring + Slack-facing behavior + persistence/routing boundaries | Deterministic fake agent at the agent boundary only                             | Runtime module/function mocks for behavior paths                                                      |
| Eval (Agent Behavior) | Validate agent-facing conversational outcomes end-to-end | End-to-end harnessed conversation flows scored by judge criteria         | Case-level behavior fixtures and controlled environment flags                   | Low-level HTTP payload-shape assertions and internals-only checks                                     |

## Canonical Specs

- Unit rules: `./unit-testing.md`
- Component rules: `./component-testing.md`
- Integration rules: `./integration-testing.md`
- Evals rules: `./eval-testing.md`
- Slack HTTP fixture/MSW details: `./slack-http-mocking.md`
- Harness tool-targeting rules: `./harness-tool-context.md`

## Shared Rules Across All Layers

Layer selection is mandatory: classify the test contract first and choose `unit`, `component`, `integration`, or `eval` before writing assertions.

1. Tests must be deterministic and isolated.
2. External HTTP is blocked by default in tests and evals; use MSW or the shared HTTP interceptor fixtures. Local URLs, model endpoints, and Vercel sandbox/OIDC control-plane traffic are the only live exceptions.
3. Slack network access is blocked in tests; use MSW fixtures for Slack HTTP.
4. Use centralized fixtures/factories (`packages/junior/tests/fixtures/slack/*`) over ad-hoc payload literals when available.
5. Prefer asserting user-visible behavior and external contracts over implementation details.
6. Keep test names descriptive of outcomes, not implementation mechanics.
7. Do not over-test: cover representative, high-risk scenarios for each contract, not every theoretical permutation.
8. Prefer one focused assertion path per behavior contract; add more cases only when they validate a distinct failure mode.
9. Workflow behavior integration tests should execute real runtime paths and only substitute deterministic fake agent output at the agent boundary.
10. Do not assert internal observability emission (`logInfo`, `logWarn`, spans, trace attributes) in behavior tests unless instrumentation output is itself the contract under test.
11. Do not assert prompt prose by checking that a string is present in a generated prompt. Prompt wording is not a stable contract; validate the resulting behavior in evals or integration tests instead.
12. If Slack API call shape or ordering is the external contract under test, keep those assertions in dedicated transport-contract integration suites; general behavior files should stay scenario-readable.
13. Prefer real in-memory adapters, fixtures, and harnesses over bespoke fake stores when the contract crosses module boundaries.

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

Ask these questions in order:

1. Does the contract depend on the model choosing the right behavior or producing the right reply quality?
   Use `eval`.
   Examples: natural-language routing, passive participation, multi-turn continuity, prompt/skill behavior, research-answer shape.
2. Otherwise, is this a product/runtime change whose contract is real wiring, Slack-visible behavior, auth resume, final delivery, or API contract effects?
   Use `integration`.
3. Otherwise, is this a deterministic service/runtime contract that crosses modules but can be proven through real domain code plus explicit local ports?
   Use `component`.
   Examples: mailbox/lease state machines, queue wake-up coordination, heartbeat repair, persistence adapter contracts, workflow runner decisions, and service orchestration with fake queue/clock/agent-runner ports.
4. Otherwise, is the contract tightly local deterministic logic or an algorithmic invariant?
   Use `unit`.
   Examples: retry math, pure transforms, normalization, local scoring, parser behavior, deterministic state transitions.

If a test needs to mock large parts of the runtime just to prove a user-visible flow, that is usually evidence the test belongs in integration or eval instead.

## Mock Confidence Rules

These rules are mandatory whenever mocks or fakes appear in a test.

1. Mock one boundary, not a whole workflow.
2. The mocked boundary must be the thing the layer is explicitly allowed to replace.
3. If a component test needs fake ports, keep them explicit and role-named. Do not use module-level mocks to steer unrelated runtime branches.
4. If a test needs to fake persisted state, Slack delivery, and reply execution together to prove one user-visible outcome, move it to integration or eval.
5. If the same user-visible contract is already covered by a higher-fidelity integration or eval test, narrow the mocked test to a local invariant or delete it.
6. Prefer real memory-backed state and the shared Slack/MSW harness over ad-hoc `Map` stores when the behavior crosses handler/runtime boundaries.

## Enforcement

`pnpm lint` enforces major Slack boundary rules for designated integration behavior tests:

- Eval files cannot import Slack contract internals.
- Integration behavior tests cannot use runtime module mocks.

See the ast-grep rules under `ast-grep/rules/`.
