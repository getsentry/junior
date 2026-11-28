import { Component, useEffect, useState, type ReactNode } from "react";

import { Button } from "./components/ui/button";
import { JuniorLogo } from "./components/JuniorLogo";
import { LoadingView } from "./components/LoadingView";
import {
  dashboardServerVersion,
  reloadForNewDashboardVersion,
} from "./dashboard-version";
import { readDashboardResponse } from "./http";
import { cn, dashboardContainerClass } from "./styles";

type RouteErrorBoundaryState = {
  error: boolean;
  resetKey: string;
};

/**
 * Catch a page that fails to render, such as a lazy page whose file is gone
 * after a deploy, so the shell around it stays usable. A new `resetKey`,
 * such as the next path, clears the error.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  RouteErrorBoundaryState
> {
  override state: RouteErrorBoundaryState = {
    error: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(): Partial<RouteErrorBoundaryState> {
    return { error: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: RouteErrorBoundaryState,
  ): Partial<RouteErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: false, resetKey: props.resetKey };
  }

  override render() {
    return this.state.error ? <RouteLoadError /> : this.props.children;
  }
}

/**
 * Show that the page failed, with a reload. When the server runs a newer
 * version, the failure is likely this tab's old files, so it reloads once
 * instead.
 */
export function RouteLoadError() {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let current = true;
    void readDashboardResponse("/api/versions")
      .then(async (response) => {
        await response.body?.cancel();
        return dashboardServerVersion(response);
      })
      .catch(() => undefined)
      .then((version) => {
        if (current && !reloadForNewDashboardVersion(version)) setChecked(true);
      });
    return () => {
      current = false;
    };
  }, []);
  if (!checked) return <LoadingView label="Loading page" />;
  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-h-[calc(100dvh-5rem)] place-items-center px-4 py-8 md:px-8",
      )}
    >
      <section
        className="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-4"
        role="alert"
      >
        <JuniorLogo />
        <div className="font-bold">This page failed to load</div>
        <Button
          className="col-start-2 justify-self-start"
          onClick={() => window.location.reload()}
          variant="outline"
        >
          Reload
        </Button>
      </section>
    </div>
  );
}
