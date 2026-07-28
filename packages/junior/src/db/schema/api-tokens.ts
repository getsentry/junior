import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

export const juniorApiTokens = pgTable(
  "junior_api_tokens",
  {
    id: text("id").primaryKey(),
    ownerEmailNormalized: text("owner_email_normalized").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenSuffix: text("token_suffix").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    uniqueIndex("junior_api_tokens_token_hash_uidx").on(table.tokenHash),
    index("junior_api_tokens_owner_email_idx").on(table.ownerEmailNormalized),
  ],
);
