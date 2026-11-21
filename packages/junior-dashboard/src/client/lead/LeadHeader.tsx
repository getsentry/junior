import type { ReactNode } from "react";
import { LeadMark } from "./LeadMark";

/** The Lead's column: the transcript width, centered. */
export const leadColumnClass = "mx-auto w-full max-w-[47.5rem]";

/** Name the Lead page and say what it is for. */
export function LeadHeader(props: {
  /** Shows or hides the conversation list when it is beside the Lead. */
  sidebarToggle?: ReactNode | undefined;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-dashboard-border-subtle px-4 py-3 sm:px-6">
      {props.sidebarToggle}
      <div className={`${leadColumnClass} flex min-w-0 items-center gap-3`}>
        <LeadMark size="header" />
        <div className="min-w-0">
          <h1 className="font-sans text-sm font-semibold text-dashboard-text">
            Your Lead
          </h1>
          <p className="truncate font-sans text-xs text-dashboard-text-muted">
            Starts and tracks your work. Only you see this.
          </p>
        </div>
      </div>
    </header>
  );
}
