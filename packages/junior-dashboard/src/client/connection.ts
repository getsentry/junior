import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/** Return the connection state used by dashboard reads and sends. */
export function useDashboardOnline(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => onlineManager.subscribe(onStoreChange),
    () => onlineManager.isOnline(),
    () => true,
  );
}
