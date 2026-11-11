import { dashboardPreviewSchema, type DashboardPreview } from "../api/schema";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_PREVIEW__?: unknown;
  }
}

/**
 * Read the Preview data mode that `withLivePreview` put in the page, if any.
 * The page sets it once, so it does not change while the page is open.
 */
export function readDashboardPreview(): DashboardPreview | undefined {
  if (typeof window === "undefined") return undefined;
  return dashboardPreviewSchema.safeParse(window.__JUNIOR_DASHBOARD_PREVIEW__)
    .data;
}
