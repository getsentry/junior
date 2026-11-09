import {
  boolean,
  integer,
  jsonb,
  text,
  pgTable,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { NotificationSchedule } from "@/chat/notifications/schedule";
import { timestamptz } from "./timestamps";

/** Hours auto-archive waits when the user has not picked a grace period. */
export const AUTO_ARCHIVE_DEFAULT_GRACE_HOURS = 24;

export const juniorUsers = pgTable(
  "junior_users",
  {
    id: text("id").primaryKey(),
    primaryEmail: text("primary_email").notNull(),
    primaryEmailNormalized: text("primary_email_normalized").notNull(),
    displayName: text("display_name"),
    timezone: text("timezone"),
    /** Text the user saved to change how Junior replies to them. */
    customization: text("customization"),
    /** Push notification hours. Null means the default schedule. */
    notificationSchedule: jsonb(
      "notification_schedule",
    ).$type<NotificationSchedule>(),
    /** Junior-wide admin role. Only the `junior admin` CLI changes it. */
    isAdmin: boolean("is_admin").notNull().default(false),
    /** Auto-archive this user's conversations when their work is done. */
    autoArchiveDefault: boolean("auto_archive_default")
      .notNull()
      .default(false),
    /** Hours done work and the conversation stay quiet before auto-archive. */
    autoArchiveGraceHours: integer("auto_archive_grace_hours")
      .notNull()
      .default(AUTO_ARCHIVE_DEFAULT_GRACE_HOURS),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_users_primary_email_normalized_uidx").on(
      table.primaryEmailNormalized,
    ),
  ],
);
