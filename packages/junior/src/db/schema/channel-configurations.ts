import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { ChannelConfigState } from "@/chat/configuration/types";
import { timestamptz } from "./timestamps";

/** Durable user configuration scoped to one provider channel. */
export const juniorChannelConfigurations = pgTable(
  "junior_channel_configurations",
  {
    channelId: text("channel_id").primaryKey(),
    configuration: jsonb("configuration_json")
      .$type<ChannelConfigState>()
      .notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
);
