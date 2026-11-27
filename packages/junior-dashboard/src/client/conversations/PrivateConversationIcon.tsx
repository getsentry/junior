import { LockKeyhole } from "lucide-react";

import { cn } from "../styles";

/** Mark a private Conversation in a list row. */
export function PrivateConversationIcon(props: { className?: string }) {
  return (
    <LockKeyhole
      aria-label="Private conversation"
      className={cn(
        "size-3 shrink-0 text-dashboard-text-faint",
        props.className,
      )}
      role="img"
    />
  );
}
