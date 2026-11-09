import { useQueryClient } from "@tanstack/react-query";
import { useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { getDashboardAgentName } from "../agentName";
import { useToastManager } from "../components/ui/toast";
import {
  currentPushSubscription,
  pushSupport,
  registerDashboardServiceWorker,
} from "./push";
import {
  notificationSettingsQuery,
  PUSH_NOTIFICATIONS_SETTINGS_PATH,
  sendTestNotification,
  turnOnThisDevice,
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

// The toast stack renders outside the router, so links are buttons that
// navigate through the hook's router.
function ToastLink(props: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="cursor-pointer border-0 bg-transparent p-0 font-medium text-dashboard-text underline underline-offset-2"
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

/**
 * Tell the viewer once per browser that Junior can send a push notification
 * when it replies, and let them turn it on in the toast. Call it after the
 * viewer starts a dashboard Conversation: that is when a reply notification
 * helps. The tip does not show when the install has no Web Push keys, the
 * browser cannot receive notifications, or this device already gets them.
 */
export function usePushNotificationsTip(): () => void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { add, close, update } = useToastManager();

  const offer = useCallback(async () => {
    if (tipShown()) return;
    const support = pushSupport();
    if (support === "unsupported") return;
    const settings = await queryClient.fetchQuery(notificationSettingsQuery);
    const publicKey = settings.publicKey;
    if (!publicKey) return;
    const subscribed =
      support === "supported" && Boolean(await currentPushSubscription());
    markTipShown();
    if (subscribed) return;

    function openSettings() {
      close(TIP_TOAST_ID);
      void navigate(PUSH_NOTIFICATIONS_SETTINGS_PATH);
    }
    const settingsLink = <ToastLink onClick={openSettings}>Settings</ToastLink>;
    function showOn(result?: string) {
      update(TIP_TOAST_ID, {
        actionProps: undefined,
        description: (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {result ?? (
              <ToastLink onClick={() => void sendTest()}>Send a test</ToastLink>
            )}
            {settingsLink}
          </span>
        ),
        timeout: TIP_TIMEOUT_MS,
        title: "Push notifications are on",
        type: "success",
      });
    }
    async function sendTest() {
      try {
        const { delivered } = await sendTestNotification();
        showOn(delivered > 0 ? "Test sent." : "No device got the test.");
      } catch {
        showOn("Could not send the test.");
      }
    }
    async function turnOn(key: string) {
      update(TIP_TOAST_ID, {
        actionProps: { children: "Turning on…", disabled: true },
        // The loading type stops the auto-dismiss timer while the browser asks.
        type: "loading",
      });
      try {
        await turnOnThisDevice(queryClient, key);
        showOn();
      } catch {
        update(TIP_TOAST_ID, {
          actionProps: undefined,
          description: settingsLink,
          timeout: TIP_TIMEOUT_MS,
          title: "Could not turn on push notifications",
          type: "error",
        });
      }
    }

    // iPhone and iPad must add the dashboard to the Home Screen first.
    // Settings explains how, so the tip links there.
    if (support === "supported") {
      // Install the worker now, so the subscribe call after the tap is quick.
      void registerDashboardServiceWorker()?.catch(() => undefined);
    }
    add({
      actionProps:
        support === "supported"
          ? { children: "Turn on", onClick: () => void turnOn(publicKey) }
          : { children: "Set up", onClick: openSettings },
      description: `Get a push notification when ${getDashboardAgentName()} replies.`,
      id: TIP_TOAST_ID,
      timeout: TIP_TIMEOUT_MS,
      title: "Push notifications",
      type: "info",
    });
  }, [add, close, navigate, queryClient, update]);

  // A failed check only skips the tip. It shows on a later Conversation.
  return useCallback(() => void offer().catch(() => undefined), [offer]);
}
