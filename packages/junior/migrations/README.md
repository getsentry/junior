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
migrations are applied by Drizzle in journal order. Baseline adoption requires
the legacy `junior_agent_steps` base table and no
`junior_conversation_events` table. A post-cutover schema without its Drizzle
journal fails closed for operator repair instead of inferring completed
migrations from mutable table shape. Every expected legacy migration record
must retain its exact historical checksum; an ID alone cannot prove which SQL
ran. Legacy metrics adoption likewise requires either none or all four metric
columns, with the legacy metrics record agreeing with that physical state. The
later search index and `metric_run_id` column must also be absent because only
the Drizzle journal may prove those immutable migrations ran.

`0004_conversation_events.sql` temporarily creates `junior_agent_steps` as an
updatable 0.103.x compatibility view. It maps legacy `pi_message` reads and
writes to canonical `message` events while the first event rewrite runs.

`0005_visible_message_events.sql` is the hard cut: drain every 0.103.x worker
before applying it because it drops the legacy view and its functions. Run the
final visible-message backfill next and require zero-gap verification before
starting new workers.

`0007_conversation_lineage.sql` expands conversation metadata with immutable
child lineage and fork correlation. The subsequent bounded upgrade backfill
fills historical root IDs only; unknown historical fork points stay null.
