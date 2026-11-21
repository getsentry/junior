import type { ReactNode } from "react";

import { cn } from "../styles";
import { LeadMark } from "./LeadMark";

/** Name the Lead page and say what it is for. */
export function LeadHeader(props: {
  /**
   * Hide it on small screens, where the app bar already names the open
   * Conversation, such as on `/conversations/:id`.
   */
  mobileHidden: boolean;
  /** Shows or hides the conversation list when it is beside the Lead. */
  sidebarToggle?: ReactNode | undefined;
}) {
  return (
    <header
      className={cn(
        "grid items-center border-b border-dashboard-border-subtle px-4 py-3 sm:px-6",
        // Equal side tracks keep the title on the transcript's center line
        // when the list toggle is on the left.
        props.sidebarToggle !== undefined &&
          "grid-cols-[2.25rem_minmax(0,1fr)_2.25rem]",
        props.mobileHidden && "hidden md:grid",
      )}
    >
      {props.sidebarToggle !== undefined ? (
        <span className="flex items-center">{props.sidebarToggle}</span>
      ) : null}
      <div className="mx-auto flex w-full min-w-0 max-w-[52.5rem] items-center gap-3">
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
