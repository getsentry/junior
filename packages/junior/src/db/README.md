# Junior SQL

Drizzle schema definitions live in `schema/`. Generate migrations with
`pnpm --filter @sentry/junior db:generate`. The `junior upgrade` command
applies pending migrations in a transaction.

## Plugin report index

`junior_conversation_events_plugin_report_idx` supports plugin event cost
reports across Conversations. Its keys are event namespace, event name, and
creation time. It includes only `structured_event` rows. Keep the JSON
expressions aligned with `chat/plugins/conversation-event-stats.ts`.

The current report queries use unnamed parameterized statements. PostgreSQL
can use the partial index when it plans those statements with their bound
values. If a report moves to a cached generic plan, check its EXPLAIN output:
a generic plan cannot infer `type = 'structured_event'` from an unknown
parameter.

### Upgrade a busy database

Migration `0062_plugin_report_index` creates this index with a normal index
build. That build blocks event writes until the migration transaction ends.
For a busy database, build the index concurrently before running the upgrade.
This avoids the write lock from a normal build. It still adds database work.

First check whether the index already exists:

```sql
SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
FROM pg_index AS i
WHERE i.indexrelid =
  to_regclass('public.junior_conversation_events_plugin_report_idx');
```

If there is no row, run this statement on its own against the primary
database, outside a transaction. The migration runner cannot run it.

```sql
CREATE INDEX CONCURRENTLY junior_conversation_events_plugin_report_idx
ON public.junior_conversation_events USING btree
  ((payload->>'namespace'), (payload->>'name'), created_at)
WHERE type = 'structured_event';
```

Run the catalog query again. Confirm that both flags are true and that the
definition has the three keys and predicate above. If the build fails, it can
leave an invalid index. Repair that build before the upgrade. Do not treat an
index name alone as a successful build.

Then run `junior upgrade`. The migration accepts the existing index and rejects
one that is not valid and ready. Check the daily and hourly report plans after
deployment. Compare report values with the values before deployment.
