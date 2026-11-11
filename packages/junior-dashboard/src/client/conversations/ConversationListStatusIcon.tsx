import { LockKeyhole } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { VisualStatus } from "../types";

/**
 * Render the row marker. Rows use three channels: the section for position,
 * a dot with a bold title for read state, and a spinner for a running Turn.
 * Waiting rows use the same dot as unread rows; their section and chip say
 * why. Private, failed, and stopped go in `ConversationStatusText`.
 */
export function ConversationListStatusIcon(props: {
  status: VisualStatus;
  unread: boolean;
  waitingOnViewer: boolean;
}) {
  if (props.status === "active") {
    return <Spinner aria-label="Running" className="size-3 text-emerald-300" />;
  }
  if (props.unread || props.waitingOnViewer) {
    return (
      <span
        aria-label={props.waitingOnViewer ? "Waiting on you" : "Unread"}
        className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
        role="img"
      />
    );
  }
  return null;
}

/** Secondary row text for a private, failed, or stopped conversation. */
export function ConversationStatusText(props: {
  className?: string;
  isPrivate: boolean;
  status: VisualStatus;
}) {
  if (
    !props.isPrivate &&
    props.status !== "failed" &&
    props.status !== "stopped"
  )
    return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-sans text-xs",
        props.className,
      )}
    >
      {props.isPrivate ? (
        <LockKeyhole
          aria-label="Private conversation"
          className="size-3 shrink-0 text-dashboard-text-faint"
          role="img"
        />
      ) : null}
      {props.status === "failed" ? (
        <span className="text-rose-400">Failed</span>
      ) : props.status === "stopped" ? (
        <span className="text-dashboard-text-muted">Stopped</span>
      ) : null}
    </span>
  );
}
