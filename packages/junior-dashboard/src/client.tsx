import { QueryClientProvider } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { DashboardShell } from "./client/App";
import { client } from "./client/api";

declare global {
  interface Window {
    __JUNIOR_DASHBOARD_BASE_PATH__?: string;
    __JUNIOR_DASHBOARD_SHOW_ERROR__?: (error: unknown) => void;
  }
}

type ErrorBoundaryState = {
  error: Error | null;
};

class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const stack = error.stack ?? errorInfo.componentStack;
    window.__JUNIOR_DASHBOARD_SHOW_ERROR__?.(stack ? new Error(stack) : error);
  }

  render() {
    if (this.state.error) {
      return <DashboardErrorPanel error={this.state.error} />;
    }

    return this.props.children;
  }
}

function DashboardErrorPanel(props: { error: Error }) {
  return (
    <main className="deck">
      <section className="dashboard-error-page">
        <div className="dashboard-error-panel">
          <div className="kicker">Dashboard Error</div>
          <h1>Junior failed to render</h1>
          <p>
            The dashboard hit a client-side exception. The stack trace is shown
            here so the page does not fail blank.
          </p>
          <pre>{props.error.stack ?? props.error.message}</pre>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("dashboard-root");
if (!root) {
  throw new Error("Junior dashboard root element was not found");
}

createRoot(root).render(
  <DashboardErrorBoundary>
    <QueryClientProvider client={client}>
      <BrowserRouter basename={window.__JUNIOR_DASHBOARD_BASE_PATH__ ?? "/"}>
        <DashboardShell />
      </BrowserRouter>
    </QueryClientProvider>
  </DashboardErrorBoundary>,
);
