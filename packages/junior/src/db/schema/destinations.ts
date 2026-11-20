import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { JuniorDestinationKind } from "./destination-kind";
import { timestamptz } from "./timestamps";

export type JuniorDestinationVisibility =
  | "direct"
  | "private"
  | "public"
  | "unknown";

// TODO(dcramer): Rename this legacy destination table and its provider fields
// to Location terms after the SQL migration and deployed reader cutover.
// Conversations share a row only when they have the same audience. Access
// between Conversations depends on this (policies/conversation-access.md).
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
