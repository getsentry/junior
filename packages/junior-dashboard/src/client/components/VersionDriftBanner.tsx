import {
  DASHBOARD_VERSION_DRIFT_MESSAGE,
  dashboardVersionDrift,
} from "../dashboard-version";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

/** Prompt the viewer to load the dashboard bundle that matches the server. */
export function VersionDriftBanner(props: {
  serverVersion?: string | undefined;
}) {
  if (!dashboardVersionDrift(props.serverVersion)) return null;

  return (
    <Alert
      aria-live="polite"
      className="border-dashboard-accent/15 bg-dashboard-accent/[0.07] text-dashboard-accent-text/80"
      role="status"
      variant="banner"
    >
      <span>{DASHBOARD_VERSION_DRIFT_MESSAGE}</span>
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
