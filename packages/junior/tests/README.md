# Junior Test Harness

Test-layer judgment is owned by `../../../policies/testing.md`. This file only
documents the package-local harness and commands.

## Layout

- `unit/`: local deterministic logic and algorithms.
- `component/`: deterministic contracts crossing a small number of modules.
- `integration/`: product/runtime behavior through real wiring.
- `msw/`: shared outbound HTTP interception and captured request helpers.
- `fixtures/slack/`: canonical Slack payload and identifier factories.

Use `../../junior-evals/README.md` for model-dependent behavior and
`../../docs/src/content/docs/contribute/local-agent-validation.md` for local
app-facing validation.

## Commands

Run one test file:

```bash
pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts
```

Run the package suite:

```bash
pnpm --filter @sentry/junior test
```

Slack HTTP tests use the global MSW setup in `msw/setup.ts`, handlers in
`msw/handlers/slack-api.ts`, and factories in `fixtures/slack/factories/`.
Do not create per-test MSW servers or mock the Slack SDK for outbound contract
tests.

## Postgres Harness

When `JUNIOR_TEST_DATABASE_URL` is configured, global setup creates a migrated
template and isolated worker databases. Worker setup points normal product
imports at the worker database and resets application tables before each test
while preserving migration journals.

- Use normal product imports for integration and component tests.
- Use `createMigratedJuniorSqlFixture()` only when a test needs one pinned,
  rollback-only transaction.
- Use `createEmptyJuniorSqlFixture()` for migration contract tests.
- Nested fixture transactions use savepoints and never commit the outer test
  transaction.
- Preserve Vitest file parallelism; database isolation is worker-scoped.
- Migration tests apply the migration explicitly instead of asserting template
  setup side effects.
- Database cleanup must identify and terminate only harness-owned connections.
