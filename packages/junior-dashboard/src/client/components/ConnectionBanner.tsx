import { useDashboardOnline } from "../connection";
import { Alert } from "./ui/alert";

/** Explain that cached data remains visible while network reads are paused. */
export function ConnectionBanner() {
  const online = useDashboardOnline();
  if (online) return null;

  return (
    <Alert aria-live="polite" layout="banner" role="status" variant="warning">
      You’re offline. Drafts stay on this device.
    </Alert>
  );
}
