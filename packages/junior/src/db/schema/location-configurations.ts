import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { LocationConfigState } from "@/chat/configuration/types";
import { juniorDestinations } from "./destinations";
import { timestamptz } from "./timestamps";

/** Durable user configuration scoped to one provider Location. */
export const juniorLocationConfigurations = pgTable(
  "junior_location_configurations",
  {
    locationId: text("location_id")
      .primaryKey()
      .references(() => juniorDestinations.id, { onDelete: "cascade" }),
    configuration: jsonb("configuration_json")
      .$type<LocationConfigState>()
      .notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
);
