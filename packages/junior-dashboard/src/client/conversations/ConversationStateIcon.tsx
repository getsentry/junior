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
 * nothing. A row without a tree state works while
 * its own Turn is queued or running.
 */
export function conversationDisplayState(
  conversation: Pick<
    Conversation,
    "pinnedAt" | "treeState" | "turnActive" | "watching"
  >,
): ConversationDisplayState | undefined {
  const tree = conversation.treeState;
  if (tree === "needs_you") return "needs_you";
  if (tree === "working") return "working";
  if (!tree && conversation.turnActive) return "working";
  if (conversation.watching) return "watching";
  return conversation.pinnedAt ? "pinned" : undefined;
}

const STATE_LABELS: Record<ConversationDisplayState, string> = {
  needs_you: "Waiting on you",
  pinned: "Pinned",
  watching: "Watching for an event",
  working: "Working",
};

/**
 * Render the one state icon of a Conversation row: a question mark when it
 * waits on the viewer, a spinner while it works, an eye while it watches for
 * an Event or Timer, and a pin when it is pinned. Nothing otherwise. Hover
 * shows the label, since an icon alone does not say what it means.
 */
export function ConversationStateIcon(props: {
  className?: string;
  state: ConversationDisplayState | undefined;
}) {
  if (!props.state) return null;
  const label = STATE_LABELS[props.state];
  // A `title` attribute, not an SVG `<title>`, so the label stays out of the
  // text of the row or chip that holds the icon.
  return (
    <span
      className={cn("inline-flex size-3.5 shrink-0", props.className)}
      title={label}
    >
      {stateIcon(props.state, label)}
    </span>
  );
}

function stateIcon(state: ConversationDisplayState, label: string) {
  const className = "size-full";
  switch (state) {
    case "needs_you":
      return (
        <CircleHelp
          aria-label={label}
          className={cn(className, "text-dashboard-accent-text")}
          role="img"
          strokeWidth={2.2}
        />
      );
    case "working":
      return (
        <Spinner
          aria-label={label}
          className={cn(className, "text-emerald-500 dark:text-emerald-300")}
        />
      );
    case "watching":
      return (
        <Eye
          aria-label={label}
          className={cn(className, "text-dashboard-text-faint")}
          role="img"
        />
      );
    case "pinned":
      return (
        <Pin
          aria-label={label}
          className={cn(className, "text-dashboard-text-muted")}
          role="img"
        />
      );
  }
}
