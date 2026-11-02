# Junior Test Harness

`policies/testing.md` owns test-layer choice. Model-dependent behavior goes in
`packages/junior-evals`.

## Layers

| Directory          | Use for                                                  |
| ------------------ | -------------------------------------------------------- |
| `unit/`            | Local fixed logic and algorithms                         |
| `component/`       | Fixed contracts across a few modules, or tests that fake |
|                    | internal modules or edges other than Slack and LLMs      |
| `integration/`     | Product and runtime behavior through real Junior wiring  |
| `integration/api/` | One test module for each `src/api/` route module         |

## Rules

- Integration tests fake Slack and LLMs only through the shared harnesses.
  No mocks of `@/` modules or other edges such as `@vercel/sandbox`. Rewrite
  the test through real wiring, move it to `component/`, or delete it.
- `pnpm test-architecture:check` also blocks Pi agent mocks, made-up agent
  outcomes, scripted agent runners, and unsafe Slack double casts.
- No per-test MSW servers. Do not mock the Slack SDK for outbound contract
  tests.
- Do not cast partial objects to `SlackAdapter`, `Thread`, or `Message`.
- Do not replace the agent runner only to control model output.
- Every `completeObject` schema must pass `strictProviderSchemaProblems` in
  its owning unit test. The gateway reports strict-schema errors only at
  request time.

## Harnesses

| Need                   | Use                                                            |
| ---------------------- | -------------------------------------------------------------- |
| Slack HTTP             | `msw/setup.ts`, `msw/handlers/slack-api.ts`, `fixtures/slack/` |
| Slack messages/threads | `fixtures/slack-harness.ts`                                    |
| Fixed model output     | `fixtures/model-stream.ts` with the real agent                 |
| SQL                    | Normal product imports (worker database)                       |
| One pinned transaction | `createMigratedJuniorSqlFixture()`                             |
| Empty schema           | `createEmptyJuniorSqlFixture()`                                |
| S3 storage test        | `docker compose up -d s3` from the repo root                   |

## Postgres

- With `JUNIOR_TEST_DATABASE_URL`, global setup makes a migrated template and
  one database per worker. Tables reset before each test.
- Keep Vitest file parallelism. Database isolation is per worker.
- Fixture transactions never commit the outer test transaction.
- Cleanup stops only connections that the harness owns.
