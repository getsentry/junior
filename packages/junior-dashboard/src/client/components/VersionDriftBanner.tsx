import { JUNIOR_VERSION } from "@sentry/junior/version";

import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

/** Prompt the viewer to load the dashboard bundle that matches the server. */
export function VersionDriftBanner(props: { serverVersion?: string }) {
  if (!dashboardVersionDrift(props.serverVersion)) return null;

  return (
    <Alert aria-live="polite" layout="banner" role="status" variant="accent">
      <span>The dashboard changed. Refresh to load the latest version.</span>
      <Button
        className="text-xs font-semibold leading-normal text-dashboard-accent-text underline decoration-dashboard-accent/40 underline-offset-2 hover:text-dashboard-text-solid"
        onClick={() => window.location.reload()}
        variant="link"
      >
        Refresh
      </Button>
    </Alert>
  );
}

/** Report whether the browser bundle and server use different known versions. */
export function dashboardVersionDrift(serverVersion?: string): boolean {
  return (
    Boolean(serverVersion) &&
    JUNIOR_VERSION !== "unknown" &&
    serverVersion !== "unknown" &&
    serverVersion !== JUNIOR_VERSION
  );
}
