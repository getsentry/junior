import { useLocation } from "react-router";

import {
  dashboardPreviewSchema,
  LIVE_PREVIEW_PARAM,
  type DashboardPreview,
} from "../../api/schema";
import { Alert } from "./ui/alert";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_PREVIEW__?: unknown;
  }
}

const linkClass =
  "font-semibold text-dashboard-accent-text underline decoration-dashboard-accent/40 underline-offset-2 hover:text-dashboard-text-solid";

/** Read the Preview data mode that the page shell embedded, if any. */
export function readDashboardPreview(): DashboardPreview | undefined {
  if (typeof window === "undefined") return undefined;
  return dashboardPreviewSchema.safeParse(window.__JUNIOR_DASHBOARD_PREVIEW__)
    .data;
}

/** Say which data a Preview shows, and link to the other data. */
export function PreviewBanner(props: { preview: DashboardPreview }) {
  const location = useLocation();
  const { live, liveOrigin } = props.preview;
  const host = new URL(liveOrigin).host;
  const basePath = window.__JUNIOR_DASHBOARD_BASE_PATH__ ?? "/";

  return (
    <Alert
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-none border-0 border-t border-dashboard-accent/15 bg-dashboard-accent/[0.07] px-3 py-1.5 text-center font-sans text-xs text-dashboard-accent-text/80"
      role="status"
    >
      {live ? (
        <span>
          You are seeing a preview of{" "}
          <a
            className={linkClass}
            href={`${liveOrigin}${location.pathname}${location.search}`}
          >
            {host}
          </a>
          . Read-only.
        </span>
      ) : (
        <>
          <span>Demo data.</span>
          {/* A full page load, so the server can ask for a personal token. */}
          <a className={linkClass} href={`${basePath}?${LIVE_PREVIEW_PARAM}`}>
            Use live data from {host}
          </a>
        </>
      )}
    </Alert>
  );
}
