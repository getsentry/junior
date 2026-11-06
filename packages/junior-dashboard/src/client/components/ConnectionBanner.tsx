import { useDashboardOnline } from "../connection";
import { Alert } from "./ui/alert";

/** Explain that cached data remains visible while network reads are paused. */
export function ConnectionBanner() {
  const online = useDashboardOnline();
  if (online) return null;

  return (
    <Alert
      aria-live="polite"
      className="block rounded-none border-0 border-t border-amber-300/15 bg-amber-300/[0.07] px-3 py-1.5 text-center font-sans text-xs text-amber-100/80"
      role="status"
    >
      You’re offline. Drafts stay on this device.
    </Alert>
  );
}
