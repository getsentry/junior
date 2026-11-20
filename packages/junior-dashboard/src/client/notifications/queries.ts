import {
  notificationSettingsSchema,
  testNotificationResponseSchema,
} from "@sentry/junior/api/schema";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { fetchDashboardJson, post } from "../http";
import { subscribeThisDevice } from "./push";

/** API path of the viewer's push notification settings. */
export const NOTIFICATIONS_PATH = "/api/notifications";

/** Element id of the push notification settings on the Settings page. */
export const PUSH_NOTIFICATIONS_ANCHOR = "push-notifications";

/** Settings page link that scrolls to the push notification settings. */
export const PUSH_NOTIFICATIONS_SETTINGS_PATH = `/settings#${PUSH_NOTIFICATIONS_ANCHOR}`;

/** Query key of this device's push subscription endpoint. */
export const pushDeviceQueryKey = [
  "dashboard",
  "notifications",
  "device",
] as const;

/** Read the viewer's push notification settings. */
export const notificationSettingsQuery = queryOptions({
  queryKey: ["dashboard", "notifications"] as const,
  queryFn: ({ signal }) =>
    fetchDashboardJson(notificationSettingsSchema, NOTIFICATIONS_PATH, signal),
});

/**
 * Ask for permission, subscribe this device, and save the subscription for
 * the viewer. Call it from a click: browsers prompt only after a gesture.
 */
export async function turnOnThisDevice(
  queryClient: QueryClient,
  publicKey: string,
) {
  const subscription = await subscribeThisDevice(publicKey);
  const settings = await post(
    notificationSettingsSchema,
    `${NOTIFICATIONS_PATH}/subscriptions`,
    subscription,
  );
  queryClient.setQueryData(notificationSettingsQuery.queryKey, settings);
  void queryClient.invalidateQueries({ queryKey: pushDeviceQueryKey });
  return settings;
}

/** Send a test notification to every device of the viewer. */
export function sendTestNotification() {
  return post(testNotificationResponseSchema, `${NOTIFICATIONS_PATH}/test`, {});
}
