import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorDestinations } from "./destinations";
import { timestamptz } from "./timestamps";

/** Durable user configuration entries scoped to provider Locations. */
export const juniorLocationConfigurations = pgTable(
  "junior_location_configurations",
  {
    locationId: text("location_id")
      .notNull()
      .references(() => juniorDestinations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    updatedBy: text("updated_by"),
    source: text("source"),
    expiresAt: text("expires_at"),
  },
  (table) => [primaryKey({ columns: [table.locationId, table.key] })],
);
