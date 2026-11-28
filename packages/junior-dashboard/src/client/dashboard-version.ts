import { JUNIOR_VERSION } from "@sentry/junior/version";
import { useEffect, useState } from "react";
import { DASHBOARD_VERSION_HEADER } from "../dashboard-version";

const DASHBOARD_VERSION_EVENT = "junior:dashboard-version";

/** What a tab whose bundle is older than the server tells the viewer. */
export const DASHBOARD_VERSION_DRIFT_MESSAGE =
  "The dashboard changed. Refresh to load the latest version.";

/** Read the Junior version that one dashboard response reports. */
export function dashboardServerVersion(response: Response): string | undefined {
  return response.headers.get(DASHBOARD_VERSION_HEADER)?.trim() || undefined;
}

/** Publish the Junior version reported by one dashboard response. */
export function recordDashboardServerVersion(response: Response): void {
  const version = dashboardServerVersion(response);
  if (!version || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(DASHBOARD_VERSION_EVENT, { detail: version }),
  );
}

/** Return the newest Junior version reported by the dashboard server. */
export function useDashboardServerVersion(
  initialVersion?: string,
): string | undefined {
  const [version, setVersion] = useState(initialVersion);
  useEffect(() => {
    if (initialVersion) setVersion(initialVersion);
  }, [initialVersion]);
  useEffect(() => {
    const update = (event: Event) => {
      setVersion((event as CustomEvent<string>).detail);
    };
    window.addEventListener(DASHBOARD_VERSION_EVENT, update);
    return () => window.removeEventListener(DASHBOARD_VERSION_EVENT, update);
  }, []);
  return version;
}

// The version that this tab last reloaded to reach. A tab that still fails
// on that version stops, so a broken file does not reload it forever.
const RELOADED_FOR_VERSION_KEY = "junior:dashboard:reloaded-for-version";

/**
 * Reload once to load the server's newer bundle. A deploy removes the files
 * of the old bundle, so this tab's lazy files can fail to load. Returns false
 * when the versions match, or this tab already reloaded for that version.
 */
export function reloadForNewDashboardVersion(serverVersion?: string): boolean {
  if (!serverVersion || !dashboardVersionDrift(serverVersion)) return false;
  try {
    if (sessionStorage.getItem(RELOADED_FOR_VERSION_KEY) === serverVersion) {
      return false;
    }
    sessionStorage.setItem(RELOADED_FOR_VERSION_KEY, serverVersion);
  } catch {
    // Without storage, the tab cannot tell a second reload from the first.
    return false;
  }
  window.location.reload();
  return true;
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
