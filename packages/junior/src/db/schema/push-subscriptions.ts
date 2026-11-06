import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * One browser Web Push subscription for one user. A user can have one row for
 * each browser or installed dashboard app. The push service owns the endpoint.
 */
export const juniorPushSubscriptions = pgTable(
  "junior_push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_push_subscriptions_endpoint_uidx").on(table.endpoint),
    index("junior_push_subscriptions_user_idx").on(table.userId),
  ],
);
