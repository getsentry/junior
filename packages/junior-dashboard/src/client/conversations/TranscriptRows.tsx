import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../styles";

/** Align message text, activity, and loading rows at the same inset. */
export const transcriptColumnsClass =
  "grid-cols-[1.5rem_minmax(0,1fr)] gap-2 md:grid-cols-[2rem_minmax(0,1fr)] md:gap-3";

/** Align an avatar with the author row at either breakpoint. */
export const transcriptAvatarClass = "mt-1 size-6 md:mt-0 md:size-8";

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

/**
 * Lay out one transcript row at its real size.
 *
 * Rows do not use `content-visibility: auto`. A skipped row has an estimated
 * size, and it changes size when the reader scrolls near it. Above the
 * reader, each change needs a scroll correction while they scroll, and on
 * phones those corrections make the transcript jump.
 */
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
      className={cn(
        "py-1.5",
        props.indent && cn("grid", transcriptColumnsClass),
      )}
      data-scroll-anchor={props.anchorKey}
      data-transcript-seq={props.seq}
    >
      {props.indent ? (
        <div className="col-start-2 min-w-0">{props.children}</div>
      ) : (
        props.children
      )}
    </div>
  );
}
