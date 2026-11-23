import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** Lifecycle of one started plugin task. `completed` and `failed` are final. */
export type PluginTaskStatus = "pending" | "running" | "completed" | "failed";

/**
 * One plugin task that a plugin started with `tasks.start`, with its JSON
 * payload. A plugin has one row per key. `attempts` counts claimed runs.
 * While the task is `pending` or `running`, the heartbeat sends it again
 * after `lease_expires_at`, because its queue message was lost.
 */
export const juniorPluginTasks = pgTable(
  "junior_plugin_tasks",
  {
    id: text("id").primaryKey(),
    plugin: text("plugin").notNull(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").$type<PluginTaskStatus>().notNull(),
    attempts: integer("attempts").notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "junior_plugin_tasks_status_check",
      sql`${table.status} in ('pending', 'running', 'completed', 'failed')`,
    ),
    uniqueIndex("junior_plugin_tasks_plugin_key_uidx").on(
      table.plugin,
      table.key,
    ),
    index("junior_plugin_tasks_open_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} in ('pending', 'running')`),
  ],
);
