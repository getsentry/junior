import { JUNIOR_VERSION } from "@sentry/junior/version";

/** Prompt the viewer to load the dashboard bundle that matches the server. */
export function VersionDriftBanner(props: { serverVersion?: string }) {
  if (!dashboardVersionDrift(props.serverVersion)) return null;

  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-1.5 text-center font-sans text-xs text-cyan-100/80"
      role="status"
    >
      <span>The dashboard changed. Refresh to load the latest version.</span>
      <button
        className="cursor-pointer border-0 bg-transparent p-0 font-mono font-semibold text-cyan-100 underline decoration-cyan-300/40 underline-offset-2 hover:text-dashboard-text-solid"
        onClick={() => window.location.reload()}
        type="button"
      >
        Refresh
      </button>
    </div>
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
