import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../styles";
import {
  ConversationCatchUpButton,
  ConversationCatchUpCard,
} from "./ConversationCatchUp";

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
    <div className="grid gap-2 py-1" data-transcript-unread-marker="">
      <div className="flex items-center gap-3">
        <span
          aria-label="New messages"
          className="h-px flex-1 bg-dashboard-accent/50"
          role="separator"
        />
        <span
          aria-hidden="true"
          className="shrink-0 font-sans text-xs font-semibold text-dashboard-accent-text"
        >
          New
        </span>
        <ConversationCatchUpButton />
        <span className="h-px flex-1 bg-dashboard-accent/50" />
      </div>
      <ConversationCatchUpCard />
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
      className="py-1.5"
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
