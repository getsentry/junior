# SQL migrations for `@sentry/junior`

drizzle-kit is the DDL **generator** for the shared Junior SQL schema
(`src/db/schema.ts`). It is **not** the applier: `junior upgrade` applies
checksum-pinned migrations under an advisory lock with the expand-only deploy
contract (`specs/conversation-storage.md`). Never run `drizzle-kit migrate` or
`migrate()` in any runtime path.

## Baseline (0000)

`meta/0000_snapshot.json` + `meta/_journal.json` are the kit baseline for the
schema that migrations `0001_conversation_core` through
`0005_conversation_transcripts` already provision on live databases. They exist
only so `pnpm --filter @sentry/junior db:generate` diffs future schema edits
against the current state.

The `0000_*.sql` baseline file is intentionally **deleted** and must never be
registered with the runner — the inline `0001`–`0005` migrations in
`src/chat/conversations/sql/migrations.ts` own that DDL and their recorded
checksums must stay byte-stable.

## Migrations 0006 onward

1. Edit the Drizzle schema under `src/db/schema/`.
2. Run `pnpm --filter @sentry/junior db:generate`. Keep the generated
   `0006_*.sql` file (do not delete it like the baseline) plus its snapshot.
3. Register it as one line in `src/chat/conversations/sql/migrations.ts`:
   `defineMigrationFromFile("0006_<name>", "0006_<name>.sql")`.

`db:generate` emitting **"No schema changes, nothing to migrate"** means the
Drizzle schema and the recorded snapshot agree — run it in CI as the schema/DDL
parity check.
