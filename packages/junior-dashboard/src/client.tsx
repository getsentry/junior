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
    <main className="grid min-h-screen place-items-center bg-black p-8 text-white">
      <section className="w-full max-w-5xl border border-rose-400/50 bg-[#0b0b0b] p-5 font-sans">
        <div className="font-mono text-xs uppercase leading-none text-[#888]">
          Dashboard Error
        </div>
        <h1 className="mt-2 text-3xl font-bold leading-tight tracking-normal">
          Junior failed to render
        </h1>
        <p className="my-4 max-w-3xl text-[#b8b8b8]">
          The dashboard hit a client-side exception. The stack trace is shown
          here so the page does not fail blank.
        </p>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border border-white/10 bg-black p-4 font-mono text-sm leading-relaxed text-white">
          {props.error.stack ?? props.error.message}
        </pre>
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
