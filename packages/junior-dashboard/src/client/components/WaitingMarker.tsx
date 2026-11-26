import { CircleAlert } from "lucide-react";
import { cn } from "../styles";

/**
 * Mark a list row that waits on the viewer, such as a Conversation with an
 * open question or an Automation that needs a fix. Conversations and
 * Automations share it, so the mark reads the same everywhere.
 */
export function WaitingMarker(props: { className?: string }) {
  return (
    <CircleAlert
      aria-label="Waiting on you"
      className={cn(
        "size-3.5 shrink-0 text-dashboard-accent-text",
        props.className,
      )}
      role="img"
      strokeWidth={2.2}
    >
      <title>Waiting on you</title>
    </CircleAlert>
  );
}
