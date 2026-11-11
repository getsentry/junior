import { useDashboardOnline } from "../connection";
import { Alert } from "./ui/alert";

/** Explain that cached data remains visible while network reads are paused. */
export function ConnectionBanner() {
  const online = useDashboardOnline();
  if (online) return null;

  return (
    <Alert
      aria-live="polite"
      className="border-amber-300/15 bg-amber-300/[0.07] text-amber-100/80"
      role="status"
      variant="banner"
    >
      You’re offline. Drafts stay on this device.
    </Alert>
  );
}
