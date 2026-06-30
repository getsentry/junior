import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

export type JuniorDestinationKind =
  | "channel"
  | "dm"
  | "group"
  | "local_conversation"
  | "thread"
  | "web_session";

export type JuniorDestinationVisibility =
  | "direct"
  | "private"
  | "public"
  | "unknown";

export const juniorDestinations = pgTable(
  "junior_destinations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    providerDestinationId: text("provider_destination_id").notNull(),
    kind: text("kind").$type<JuniorDestinationKind>().notNull(),
    parentDestinationId: text("parent_destination_id"),
    displayName: text("display_name"),
    visibility: text("visibility")
      .$type<JuniorDestinationVisibility>()
      .notNull()
      .default("unknown"),
    metadata: jsonb("metadata_json"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_destinations_provider_destination_uidx").on(
      table.provider,
      table.providerTenantId,
      table.providerDestinationId,
    ),
    index("junior_destinations_provider_kind_idx").on(
      table.provider,
      table.kind,
    ),
  ],
);
