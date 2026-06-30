import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

export type JuniorIdentityKind = "service" | "system" | "user";

export const juniorIdentities = pgTable(
  "junior_identities",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<JuniorIdentityKind>().notNull(),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    providerSubjectId: text("provider_subject_id").notNull(),
    displayName: text("display_name"),
    handle: text("handle"),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    metadata: jsonb("metadata_json"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_identities_provider_subject_uidx").on(
      table.provider,
      table.providerTenantId,
      table.providerSubjectId,
    ),
    index("junior_identities_kind_provider_idx").on(table.kind, table.provider),
  ],
);
