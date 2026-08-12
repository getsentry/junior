import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useDashboardOnline } from "../connection";

/** Show connection loss and refresh active dashboard data after reconnect. */
export function ConnectionBanner() {
  const queryClient = useQueryClient();
  const online = useDashboardOnline();
  const wasOffline = useRef(!online);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setReconnecting(false);
      return;
    }
    if (!wasOffline.current) return;

    wasOffline.current = false;
    setReconnecting(true);
    let active = true;
    void queryClient
      .refetchQueries({ type: "active" })
      .finally(() => active && setReconnecting(false));
    return () => {
      active = false;
    };
  }, [online, queryClient]);

  if (online && !reconnecting) return null;

  return (
    <div
      aria-live="polite"
      className={
        online
          ? "border-t border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-1.5 text-center font-sans text-xs text-cyan-100/80"
          : "border-t border-amber-300/15 bg-amber-300/[0.07] px-3 py-1.5 text-center font-sans text-xs text-amber-100/80"
      }
      role="status"
    >
      {online
        ? "Back online. Refreshing…"
        : "You’re offline. Drafts stay on this device."}
    </div>
  );
}
