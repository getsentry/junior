import { notificationSettingsSchema } from "@sentry/junior/api/schema";
import { queryOptions } from "@tanstack/react-query";

import { fetchDashboardJson } from "../http";

/** API path of the viewer's push notification settings. */
export const NOTIFICATIONS_PATH = "/api/notifications";

/** Element id of the push notification settings on the Settings page. */
export const PUSH_NOTIFICATIONS_ANCHOR = "push-notifications";

/** Settings page link that scrolls to the push notification settings. */
export const PUSH_NOTIFICATIONS_SETTINGS_PATH = `/settings#${PUSH_NOTIFICATIONS_ANCHOR}`;

/** Read the viewer's push notification settings. */
export const notificationSettingsQuery = queryOptions({
  queryKey: ["dashboard", "notifications"] as const,
  queryFn: ({ signal }) =>
    fetchDashboardJson(notificationSettingsSchema, NOTIFICATIONS_PATH, signal),
});
