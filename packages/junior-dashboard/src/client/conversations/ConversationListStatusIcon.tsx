import { LockKeyhole } from "lucide-react";

import { ActiveIndicator } from "../components/ActiveIndicator";
import { cn } from "../styles";
import type { VisualStatus } from "../types";

/** Render a conversation status marker, with new completions taking priority. */
export function ConversationListStatusIcon(props: {
  finishedSinceSeen: boolean;
  isPrivate: boolean;
  status: VisualStatus;
}) {
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
          props.status === "active" &&
            "animate-[junior-active-indicator_1.8s_ease-in-out_infinite] text-emerald-300 drop-shadow-[0_0_6px_rgba(110,231,183,0.55)] motion-reduce:animate-none",
          props.status === "failed" && "text-rose-300",
          props.status === "idle" && "text-dashboard-text-muted",
        )}
      />
    );
  }

  if (props.status === "active") {
    return <ActiveIndicator className="size-1.5" />;
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.status === "failed" && "bg-rose-300",
        props.status === "idle" && "bg-white/25",
      )}
    />
  );
}
