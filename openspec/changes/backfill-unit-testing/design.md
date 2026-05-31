# Design: Unit Testing Baseline

## Sources Reviewed

- `specs/unit-testing.md`
- `specs/testing.md`
- `packages/junior/vitest.config.ts`
- representative unit tests under:
  - `packages/junior/tests/unit/skills`
  - `packages/junior/tests/unit/tools`
  - `packages/junior/tests/unit/config`
  - `packages/junior/tests/unit/plugins`
  - `packages/junior/tests/unit/runtime`
  - `packages/junior/tests/unit/misc`
  - `packages/junior/tests/unit/cli`

External primary sources reviewed:

- Vitest mocking docs for `vi.fn`, `vi.mock`, spies, and module isolation.
- Vitest config docs for node environment, include/exclude, and setup files.

## Current Pattern

Good unit tests in the repo generally:

- call one exported parser/normalizer/validator/helper;
- use table-like representative cases only where each case adds a distinct invariant;
- stub one narrow boundary such as a command runner, clock, registry function, or dependency resolver;
- avoid real network access;
- assert module outputs or thrown errors instead of runtime choreography.

Some older unit tests cover broader runtime seams. This baseline should not force a mass migration, but new or touched tests should follow the taxonomy.

## Undefined Behavior

- The repo still has broad unit tests around some runtime helpers because they predate the current testing taxonomy.
- Prompt builder unit tests exist but should not be extended by asserting exact prompt prose.
- There is no automated unit-only lint that detects over-mocked workflow simulation.

## Verification Strategy

- Focused unit command: `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`.
- Full package test includes boundary checks plus unit and integration suites.
- Review remains necessary to catch over-mocking and wrong-layer assertions.
