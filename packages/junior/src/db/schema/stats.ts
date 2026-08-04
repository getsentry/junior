import { date, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/** Daily named counters used by Junior and loaded plugins. */
export const juniorStats = pgTable(
  "junior_stats",
  {
    date: date("date", { mode: "string" }).notNull(),
    namespace: text("namespace").notNull(),
    metric: text("metric").notNull(),
    name: text("name").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "junior_stats_date_namespace_metric_name_pk",
      columns: [table.date, table.namespace, table.metric, table.name],
    }),
  ],
);
