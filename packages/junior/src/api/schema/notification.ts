import { z } from "zod";
import { notificationScheduleSchema } from "../../chat/notifications/schedule";

export { notificationScheduleSchema };
export {
  DEFAULT_NOTIFICATION_SCHEDULE,
  isWithinNotificationSchedule,
} from "../../chat/notifications/schedule";
export type { NotificationSchedule } from "../../chat/notifications/schedule";

const notificationTimezoneSourceSchema = z.enum([
  "manual",
  "slack",
  "saved",
  "default",
]);

/** The viewer's phone notification settings. */
export const notificationSettingsSchema = z
  .object({
    /** Server VAPID public key. Absent when Web Push is not configured. */
    publicKey: z.string().min(1).optional(),
    schedule: notificationScheduleSchema,
    /** Timezone that Junior uses for the schedule now. */
    timezone: z.string().min(1),
    timezoneSource: notificationTimezoneSourceSchema,
    /** Number of browsers that receive the viewer's notifications. */
    deviceCount: z.number().int().nonnegative(),
  })
  .strict();

export type NotificationSettings = z.output<typeof notificationSettingsSchema>;

/** `PushSubscription#toJSON()` from the browser. */
export const pushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().url().startsWith("https://").max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({
        auth: z.string().min(1).max(256),
        p256dh: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export const pushSubscriptionDeleteBodySchema = z
  .object({ endpoint: z.string().url().max(2048) })
  .strict();

export const testNotificationResponseSchema = z
  .object({ delivered: z.number().int().nonnegative() })
  .strict();
