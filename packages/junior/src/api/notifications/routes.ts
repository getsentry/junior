import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import {
  deletePushSubscription,
  listPushSubscriptions,
  readNotificationSchedule,
  saveNotificationSchedule,
  savePushSubscription,
} from "@/chat/notifications/store";
import { resolveNotificationTimezone } from "@/chat/notifications/timezone";
import {
  readWebPushConfig,
  sendPushNotificationToUser,
} from "@/chat/notifications/web-push";
import { getDashboardSettingsLink } from "@/chat/dashboard-link";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  notificationScheduleSchema,
  notificationSettingsSchema,
  pushSubscriptionBodySchema,
  pushSubscriptionDeleteBodySchema,
  testNotificationResponseSchema,
} from "../schema/notification";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

async function readSettings(userId: string) {
  const db = getDb();
  const nowMs = Date.now();
  const schedule = await readNotificationSchedule(db, userId);
  const [{ source, timezone }, subscriptions] = await Promise.all([
    resolveNotificationTimezone({ db, nowMs, schedule, userId }),
    listPushSubscriptions(db, userId),
  ]);
  const config = readWebPushConfig();
  return notificationSettingsSchema.parse({
    ...(config ? { publicKey: config.publicKey } : undefined),
    deviceCount: subscriptions.length,
    schedule,
    timezone,
    timezoneSource: source,
  });
}

async function settingsResponse(userId: string): Promise<Response> {
  return jsonResponse(notificationSettingsSchema, await readSettings(userId));
}

/**
 * Create authenticated routes for the viewer's phone notifications: browser
 * subscriptions, notification hours, and a test notification.
 */
export function createNotificationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) =>
    settingsResponse(context.get("viewer").id),
  );

  app.put(
    "/schedule",
    requireViewer,
    validateRequest("json", notificationScheduleSchema, "Invalid schedule."),
    async (context) => {
      const viewer = context.get("viewer");
      const saved = await saveNotificationSchedule(
        getDb(),
        viewer.id,
        context.req.valid("json"),
        Date.now(),
      );
      if (!saved) throwApiError(404, "User not found.");
      return await settingsResponse(viewer.id);
    },
  );

  app.post(
    "/subscriptions",
    requireViewer,
    validateRequest(
      "json",
      pushSubscriptionBodySchema,
      "Invalid subscription.",
    ),
    async (context) => {
      if (!readWebPushConfig()) {
        throwApiError(503, "Phone notifications are not configured.");
      }
      const viewer = context.get("viewer");
      const { endpoint, keys } = context.req.valid("json");
      await savePushSubscription(
        getDb(),
        viewer.id,
        { endpoint, keys },
        Date.now(),
      );
      logInfo("notification.subscription.saved");
      return await settingsResponse(viewer.id);
    },
  );

  app.delete(
    "/subscriptions",
    requireViewer,
    validateRequest(
      "json",
      pushSubscriptionDeleteBodySchema,
      "Invalid subscription.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      await deletePushSubscription(
        getDb(),
        viewer.id,
        context.req.valid("json").endpoint,
      );
      logInfo("notification.subscription.deleted");
      return await settingsResponse(viewer.id);
    },
  );

  // A test ignores notification hours, so a user can check a device any time.
  app.post("/test", requireViewer, async (context) => {
    const config = readWebPushConfig();
    if (!config) throwApiError(503, "Phone notifications are not configured.");
    const result = await sendPushNotificationToUser({
      config,
      db: getDb(),
      payload: {
        body: "Notifications work on this device.",
        tag: "junior-test",
        title: "Junior",
        url: getDashboardSettingsLink() ?? "/",
      },
      userId: context.get("viewer").id,
    });
    return jsonResponse(testNotificationResponseSchema, {
      delivered: result.delivered,
    });
  });

  return app;
}
