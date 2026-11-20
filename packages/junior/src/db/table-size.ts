import { metrics } from "@/chat/sentry";
import type { JuniorSqlMigrationExecutor } from "./db";

interface TableSizeRow {
  table: string;
  rows: number | string;
  bytes: number | string;
}

/**
 * Emit the estimated row count and total on-disk size of each Junior table as
 * gauges, so production table growth is visible without a table query.
 */
export async function reportTableSizes(
  executor: JuniorSqlMigrationExecutor,
): Promise<void> {
  // A catalog read: `reltuples` is the planner's row estimate, and
  // `pg_total_relation_size` includes indexes and TOAST.
  const tables = await executor.query<TableSizeRow>(`
SELECT
  c.relname AS "table",
  c.reltuples AS "rows",
  pg_total_relation_size(c.oid) AS "bytes"
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND c.relkind IN ('r', 'p')
  AND c.relname LIKE 'junior\\_%' ESCAPE '\\'
`);
  for (const table of tables) {
    const attributes = { "db.collection.name": table.table };
    const rows = Number(table.rows);
    // `reltuples` is -1 until the table is first vacuumed or analyzed.
    if (rows >= 0) {
      metrics.gauge("db.table.rows", rows, { attributes });
    }
    metrics.gauge("db.table.size", Number(table.bytes), {
      unit: "byte",
      attributes,
    });
  }
}
