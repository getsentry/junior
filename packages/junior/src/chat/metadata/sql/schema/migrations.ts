import { pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

export const juniorSchemaMigrations = pgTable("junior_schema_migrations", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamptz("applied_at").notNull().defaultNow(),
});
