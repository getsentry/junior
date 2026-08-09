import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { ConfigEntry } from "@/chat/configuration/types";
import { timestamptz } from "./timestamps";

/** Durable per-channel configuration owned by SQL, not Redis scratch. */
export const juniorChannelConfigurations = pgTable(
  "junior_channel_configurations",
  {
    channelId: text("channel_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    entries: jsonb("entries_json")
      .$type<Record<string, ConfigEntry>>()
      .notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
);
