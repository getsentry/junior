import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../styles";

/** Keep row padding and the gap between transcript entries in one place. */
export function TranscriptRows({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1", className)}
    />
  );
}

/**
 * Mark where unread rows start. The pinning hook can open the transcript here.
 */
export function TranscriptUnreadMarker() {
  return (
    <div
      className="flex items-center gap-3 py-1"
      data-transcript-unread-marker=""
      role="separator"
      aria-label="New messages"
    >
      <span className="h-px flex-1 bg-dashboard-accent/50" />
      <span className="shrink-0 font-sans text-xs font-semibold text-dashboard-accent-text">
        New
      </span>
      <span className="h-px flex-1 bg-dashboard-accent/50" />
    </div>
  );
}

/** Leave room for control outlines inside the mobile row's paint bounds. */
export function TranscriptRow(props: {
  /** Stable row id that holds the reader's place while layout changes. */
  anchorKey?: string;
  children: ReactNode;
  indent?: boolean;
  /** Last event sequence in the row. Read positions use it. */
  seq?: number;
}) {
  return (
    <div
      className="mobile-transcript-row -mx-2 px-2 py-1.5"
      data-scroll-anchor={props.anchorKey}
      data-transcript-seq={props.seq}
    >
      {props.indent ? (
        <div className="pl-11">{props.children}</div>
      ) : (
        props.children
      )}
    </div>
  );
}
