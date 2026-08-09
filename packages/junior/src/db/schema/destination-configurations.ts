import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { DestinationConfigState } from "@/chat/configuration/types";
import { timestamptz } from "./timestamps";

/** Durable user configuration scoped to one destination/location. */
export const juniorDestinationConfigurations = pgTable(
  "junior_destination_configurations",
  {
    destinationKey: text("destination_key").primaryKey(),
    configuration: jsonb("configuration_json")
      .$type<DestinationConfigState>()
      .notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
);
