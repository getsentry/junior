import { CircleHelp, Eye, Pin } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { Conversation } from "../types";

/** What a row shows for a Conversation: its tree state, else its pin. */
export type ConversationDisplayState =
  | "needs_you"
  | "working"
  | "watching"
  | "pinned";

/**
 * Pick one state for a Conversation row. When more than one applies:
 * `needs_you` > `working` > `watching` > `pinned`. A `done` tree shows
 * nothing. A row without a tree state, such as a Thread row, works while
 * its own status is `working`.
 */
export function conversationDisplayState(
  conversation: Pick<
    Conversation,
    "pinnedAt" | "status" | "treeState" | "watching"
  >,
): ConversationDisplayState | undefined {
  const tree = conversation.treeState;
  if (tree === "needs_you") return "needs_you";
  if (tree === "working") return "working";
  if (!tree && conversation.status === "working") return "working";
  if (conversation.watching) return "watching";
  return conversation.pinnedAt ? "pinned" : undefined;
}

/**
 * Render the one state icon of a Conversation row: a question mark when it
 * waits on the viewer, a spinner while it works, an eye that blinks now and
 * then while it watches for an Event or Timer, and a pin when it is pinned.
 * Nothing otherwise.
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
    case "watching":
      return (
        <Eye
          aria-label="Watching for an event"
          className={cn(
            className,
            "animate-[junior-watch-blink_30s_ease-in-out_infinite] text-dashboard-text-faint motion-reduce:animate-none",
          )}
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
