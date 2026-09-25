import { useEffect, useState } from "react";
import { DASHBOARD_VERSION_HEADER } from "../dashboard-version";

const DASHBOARD_VERSION_EVENT = "junior:dashboard-version";

/** Publish the Junior version reported by one dashboard response. */
export function recordDashboardServerVersion(response: Response): void {
  const version = response.headers.get(DASHBOARD_VERSION_HEADER)?.trim();
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
