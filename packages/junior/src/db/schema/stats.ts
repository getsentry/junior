import {
  bigint,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/**
 * Daily named counters used by Junior and loaded plugins.
 * TODO: store hour keys when dashboard 24h workspace usage needs hourly bars.
 * `date` is a Postgres date column, so counters stay day-bucketed today.
 */
export const juniorStats = pgTable(
  "junior_stats",
  {
    date: date("date", { mode: "string" }).notNull(),
    namespace: text("namespace").notNull(),
    metric: text("metric").notNull(),
    name: text("name").notNull(),
    // A bigint, so a money counter in micro-USD does not overflow in a day.
    count: bigint("value", { mode: "number" }).notNull().default(0),
    // TODO: drop in the release after micro-USD. Only the runtime before it
    // adds to this integer column, and a repair migration moves its amounts.
    legacyCount: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "junior_stats_date_namespace_metric_name_pk",
      columns: [table.date, table.namespace, table.metric, table.name],
    }),
  ],
);

/**
 * Hourly copies of the named counters that a writer asks for, such as cache
 * warming. The retention cron deletes rows older than
 * `HOURLY_STATS_RETENTION_MS`, so the table stays small.
 */
export const juniorHourlyStats = pgTable(
  "junior_hourly_stats",
  {
    /** Start of the UTC hour. */
    hour: timestamptz("hour").notNull(),
    namespace: text("namespace").notNull(),
    metric: text("metric").notNull(),
    name: text("name").notNull(),
    count: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "junior_hourly_stats_hour_namespace_metric_name_pk",
      columns: [table.hour, table.namespace, table.metric, table.name],
    }),
  ],
);
