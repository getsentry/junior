import { JUNIOR_VERSION } from "@sentry/junior/version";

import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

/** Prompt the viewer to load the dashboard bundle that matches the server. */
export function VersionDriftBanner(props: { serverVersion?: string }) {
  if (!dashboardVersionDrift(props.serverVersion)) return null;

  return (
    <Alert
      aria-live="polite"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-none border-0 border-t border-dashboard-accent/15 bg-dashboard-accent/[0.07] px-3 py-1.5 text-center font-sans text-xs text-dashboard-accent-text/80"
      role="status"
    >
      <span>The dashboard changed. Refresh to load the latest version.</span>
      <Button
        className="h-auto border-0 bg-transparent p-0 text-xs font-semibold leading-normal text-dashboard-accent-text underline decoration-dashboard-accent/40 underline-offset-2 hover:bg-transparent hover:text-dashboard-text-solid"
        onClick={() => window.location.reload()}
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
