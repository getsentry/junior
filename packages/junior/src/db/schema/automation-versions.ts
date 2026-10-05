import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/** One saved Automation definition. Lifecycle and scheduler state are not versioned. */
export const juniorAutomationVersions = pgTable(
  "junior_automation_versions",
  {
    kind: text("kind").$type<"scheduled" | "event">().notNull(),
    automationId: text("automation_id").notNull(),
    /** Starts at 1 and increases by 1 for each saved definition change. */
    version: integer("version").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    /** Slack principal that saved this definition. Null when unknown. */
    editedBy: jsonb("edited_by"),
    definition: jsonb("definition").notNull(),
  },
  (table) => [
    check(
      "junior_automation_versions_kind_check",
      sql`${table.kind} in ('scheduled', 'event')`,
    ),
    primaryKey({
      name: "junior_automation_versions_pk",
      columns: [table.kind, table.automationId, table.version],
    }),
  ],
);
