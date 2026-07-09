import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IdentityKind } from "@/chat/identities/identity";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

export const juniorIdentities = pgTable(
  "junior_identities",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<IdentityKind>().notNull(),
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
    userId: text("user_id").references(() => juniorUsers.id),
    emailNormalized: text("email_normalized"),
    emailVerified: boolean("email_verified").notNull().default(false),
  },
  (table) => [
    uniqueIndex("junior_identities_provider_subject_uidx").on(
      table.provider,
      table.providerTenantId,
      table.providerSubjectId,
    ),
    index("junior_identities_user_idx").on(table.userId),
    index("junior_identities_verified_email_idx")
      .on(table.emailNormalized)
      .where(
        sql`${table.emailVerified} = true AND ${table.emailNormalized} IS NOT NULL`,
      ),
    index("junior_identities_kind_provider_idx").on(table.kind, table.provider),
  ],
);
