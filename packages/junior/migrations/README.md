# SQL migrations for `@sentry/junior`

This is a standard Drizzle migration folder. `drizzle-kit generate` owns each
SQL file, snapshot, and journal entry; `junior upgrade` applies the folder with
Drizzle ORM's migrator before any data backfills run.

1. Edit the schema under `src/db/schema/`.
2. Run `pnpm --filter @sentry/junior db:generate --name <migration_name>`.
3. Commit the generated SQL file and `meta/` changes together.

The `0000_initial.sql` baseline represents the schema already deployed by the
pre-Drizzle Junior migration runner. During upgrade, existing installations
adopt that baseline once; new installations execute it normally. All later
migrations are applied by Drizzle in journal order.

`0004_conversation_events.sql` temporarily creates `junior_agent_steps` as an
updatable 0.103.x compatibility view. It maps legacy `pi_message` reads and
writes to canonical `message` events while the first event rewrite runs.

`0005_visible_message_events.sql` is the hard cut: drain every 0.103.x worker
before applying it because it drops the legacy view and its functions. Run the
final visible-message backfill next and require zero-gap verification before
starting new workers.
