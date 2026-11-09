import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useNavigate } from "react-router";

import { getDashboardAgentName } from "../agentName";
import { useToastManager } from "../components/ui/toast";
import { currentPushSubscription, pushSupport } from "./push";
import {
  notificationSettingsQuery,
  PUSH_NOTIFICATIONS_SETTINGS_PATH,
} from "./queries";

const TIP_SHOWN_STORAGE_KEY = "junior:dashboard:push-notifications-tip-shown";
const TIP_TOAST_ID = "push-notifications-tip";
const TIP_TIMEOUT_MS = 12_000;

function tipShown(): boolean {
  try {
    return window.localStorage.getItem(TIP_SHOWN_STORAGE_KEY) !== null;
  } catch {
    // Without storage the tip could show on every message. Skip it.
    return true;
  }
}

function markTipShown(): void {
  try {
    window.localStorage.setItem(TIP_SHOWN_STORAGE_KEY, "1");
  } catch {
    // tipShown() reports true without storage, so nothing repeats.
  }
}

/**
 * Tell the viewer once per browser that Junior can send a push notification
 * when it replies. Call it after the viewer starts a dashboard Conversation:
 * that is when a reply notification helps. The tip does not show when the
 * install has no Web Push keys, the browser cannot receive notifications, or
 * this device already gets them.
 */
export function usePushNotificationsTip(): () => void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { add, close } = useToastManager();

  const offer = useCallback(async () => {
    if (tipShown()) return;
    const support = pushSupport();
    if (support === "unsupported") return;
    const settings = await queryClient.fetchQuery(notificationSettingsQuery);
    if (!settings.publicKey) return;
    const subscribed =
      support === "supported" && Boolean(await currentPushSubscription());
    markTipShown();
    if (subscribed) return;
    add({
      actionProps: {
        children: "Turn on",
        onClick: () => {
          close(TIP_TOAST_ID);
          void navigate(PUSH_NOTIFICATIONS_SETTINGS_PATH);
        },
      },
      description: `Get a push notification when ${getDashboardAgentName()} replies.`,
      id: TIP_TOAST_ID,
      timeout: TIP_TIMEOUT_MS,
      title: "Push notifications",
      type: "info",
    });
  }, [add, close, navigate, queryClient]);

  // A failed check only skips the tip. It shows on a later Conversation.
  return useCallback(() => void offer().catch(() => undefined), [offer]);
}
