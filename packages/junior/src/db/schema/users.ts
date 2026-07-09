import { text, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

export const juniorUsers = pgTable(
  "junior_users",
  {
    id: text("id").primaryKey(),
    primaryEmail: text("primary_email").notNull(),
    primaryEmailNormalized: text("primary_email_normalized").notNull(),
    displayName: text("display_name"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_users_primary_email_normalized_uidx").on(
      table.primaryEmailNormalized,
    ),
  ],
);
