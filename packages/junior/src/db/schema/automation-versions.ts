import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorAutomations } from "./automations";

/** One saved Automation definition. Lifecycle and scheduler state are not versioned. */
export const juniorAutomationVersions = pgTable(
  "junior_automation_versions",
  {
    // TODO(dcramer): Drop kind after no deployed worker writes it. Current
    // workers leave it null; junior_automations.kind is authoritative (#2176).
    kind: text("kind").$type<"scheduled" | "event">(),
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
      columns: [table.automationId, table.version],
    }),
    foreignKey({
      name: "junior_automation_versions_automation_id_fk",
      columns: [table.automationId],
      foreignColumns: [juniorAutomations.id],
    }).onDelete("cascade"),
  ],
);
