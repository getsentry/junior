import { CircleHelp, Eye, Pin } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { Conversation } from "../types";

/** What a row shows for a Conversation: its tree state, else its pin. */
export type ConversationDisplayState =
  | NonNullable<Conversation["treeState"]>
  | "pinned";

/**
 * Pick one state for a Conversation row. When more than one applies:
 * `needs_you` > `working` > `waiting` > `pinned`. A row without a tree
 * state, such as a Thread row, works while its own status is `active`.
 */
export function conversationDisplayState(
  conversation: Pick<Conversation, "pinnedAt" | "status" | "treeState">,
): ConversationDisplayState | undefined {
  if (conversation.treeState) return conversation.treeState;
  if (conversation.status === "active") return "working";
  return conversation.pinnedAt ? "pinned" : undefined;
}

/**
 * Render the one state icon of a Conversation row: a question mark when it
 * waits on the viewer, a spinner while it works, an eye while it waits for
 * an Event or Timer, and a pin when it is pinned. Nothing otherwise.
 */
export function ConversationStateIcon(props: {
  className?: string;
  state: ConversationDisplayState | undefined;
}) {
  const className = cn("size-3.5 shrink-0", props.className);
  switch (props.state) {
    case "needs_you":
      return (
        <CircleHelp
          aria-label="Waiting on you"
          className={cn(className, "text-dashboard-accent-text")}
          role="img"
          strokeWidth={2.2}
        />
      );
    case "working":
      return (
        <Spinner
          aria-label="Working"
          className={cn(className, "text-emerald-500 dark:text-emerald-300")}
        />
      );
    case "waiting":
      return (
        <Eye
          aria-label="Waiting for an event"
          className={cn(className, "text-dashboard-text-faint")}
          role="img"
        />
      );
    case "pinned":
      return (
        <Pin
          aria-label="Pinned"
          className={cn(className, "text-dashboard-text-muted")}
          role="img"
        />
      );
    default:
      return null;
  }
}
