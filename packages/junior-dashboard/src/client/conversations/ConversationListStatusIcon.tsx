import { LockKeyhole } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { ConversationStatus } from "../types";

/**
 * Render the row marker: a spinner for a running Turn, else a dot when the
 * row waits on the viewer. Private and needs input go in
 * `ConversationStatusText`, so a `needs_input` row with a running Turn
 * shows both.
 */
export function ConversationListStatusIcon(props: {
  /** `conversationTurnIsActive` of the row, not its `status`. */
  turnActive: boolean;
  waitingOnViewer: boolean;
}) {
  if (props.turnActive) {
    return <Spinner aria-label="Running" className="size-3 text-emerald-300" />;
  }
  if (props.waitingOnViewer) {
    return (
      <span
        aria-label="Waiting on you"
        className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
        role="img"
      />
    );
  }
  return null;
}

/** Secondary row text for a private or needs input conversation. */
export function ConversationStatusText(props: {
  className?: string;
  isPrivate: boolean;
  status: ConversationStatus;
}) {
  if (!props.isPrivate && props.status !== "needs_input") return null;
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
      {props.status === "needs_input" ? (
        <span className="text-amber-400">Needs input</span>
      ) : null}
    </span>
  );
}
