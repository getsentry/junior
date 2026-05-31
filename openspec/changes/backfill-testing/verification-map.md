# Testing Verification Map

| Spec Area               | Existing Coverage                         | Layer               | Files                                                     | Status     | Notes                                                                 |
| ----------------------- | ----------------------------------------- | ------------------- | --------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Testing taxonomy prose  | layer-selection policy                    | Policy/docs         | `specs/testing.md`                                        | backfilled | This change converts top-level rules to OpenSpec.                     |
| Boundary enforcement    | eval/import and integration mock patterns | Script              | `packages/junior/scripts/check-slack-test-boundary.mjs`   | keep       | Not exhaustive.                                                       |
| Unit/integration runner | Vitest node config and MSW setup          | Config              | `packages/junior/vitest.config.ts`                        | keep       | Details split into unit/integration specs.                            |
| Slack HTTP fixtures     | MSW server and fixture factories          | Integration support | `packages/junior/tests/msw/**`, `tests/fixtures/slack/**` | split      | Owned by Slack HTTP mocking backfill.                                 |
| Eval harness            | eval scripts, replay mode, criteria       | Eval support        | `packages/junior-evals/**`                                | split      | Owned by eval-testing backfill and migration map.                     |
| Test command docs       | focused command guidance                  | Repo docs           | `AGENTS.md`, package scripts                              | keep       | Per-spec verification maps remain authoritative for changed surfaces. |
