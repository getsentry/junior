import { LockKeyhole } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { VisualStatus } from "../types";

/**
 * Render a conversation status marker. "Waiting on you" replaces every other
 * marker. A running conversation shows a spinner, so it never looks like an
 * ended one.
 */
export function ConversationListStatusIcon(props: {
  finishedSinceSeen: boolean;
  isPrivate: boolean;
  status: VisualStatus;
  waitingOnViewer: boolean;
}) {
  if (props.waitingOnViewer) {
    return (
      <span
        aria-label="Waiting on you"
        className="size-2 shrink-0 rounded-full bg-violet-300 shadow-[0_0_6px_rgba(196,181,253,0.7)]"
        role="img"
      />
    );
  }

  if (props.status === "active") {
    return <Spinner aria-label="Running" className="size-3 text-emerald-300" />;
  }

  if (props.finishedSinceSeen) {
    return (
      <span
        aria-label="Finished since last viewed"
        className="size-1.5 shrink-0 rounded-full bg-orange-300"
        role="img"
      />
    );
  }

  if (props.isPrivate) {
    return (
      <LockKeyhole
        aria-label="Private conversation"
        className={cn(
          "size-3 shrink-0",
          props.status === "failed" && "text-rose-300",
          props.status === "idle" && "text-dashboard-text-muted",
        )}
      />
    );
  }

  if (props.status === "failed") {
    return (
      <span
        aria-label="Failed"
        className="size-1.5 shrink-0 rounded-full bg-rose-300"
        role="img"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-dashboard-text-faint"
    />
  );
}
