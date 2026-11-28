import { CircleAlert, CircleHelp } from "lucide-react";
import type { SpaceReport } from "@sentry/junior/api/schema";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";

/** What a Space row shows for the Threads in the Space. */
export type SpaceDisplayState = "needs_you" | "failed" | "working";

/**
 * Pick one state for a Space row from the roll-up of its Threads.
 * When more than one applies: `needs_you` > `failed` > `working`. An idle
 * Space shows nothing.
 */
export function spaceDisplayState(
  space: Pick<SpaceReport, "latestTurnFailed" | "treeState">,
): SpaceDisplayState | undefined {
  if (space.treeState === "needs_you") return "needs_you";
  if (space.latestTurnFailed) return "failed";
  if (space.treeState === "working") return "working";
  return undefined;
}

const STATE_LABELS: Record<SpaceDisplayState, string> = {
  failed: "A Thread failed",
  needs_you: "Waiting for an answer",
  working: "Working",
};

/**
 * Render the one state icon of a Space row, in the row's text colors: a
 * question mark when a Conversation waits on the viewer, an alert when one
 * failed, and a spinner while one works. Hover shows the label.
 */
export function SpaceStateIcon(props: {
  className?: string;
  state: SpaceDisplayState | undefined;
}) {
  if (!props.state) return null;
  const label = STATE_LABELS[props.state];
  // A `title` attribute, not an SVG `<title>`, so the label stays out of the
  // text of the row that holds the icon.
  return (
    <span
      className={cn("inline-flex size-3.5 shrink-0", props.className)}
      title={label}
    >
      {stateIcon(props.state, label)}
    </span>
  );
}

function stateIcon(state: SpaceDisplayState, label: string) {
  const className = "size-full";
  switch (state) {
    case "needs_you":
      return (
        <CircleHelp
          aria-label={label}
          className={cn(className, "text-dashboard-text")}
          role="img"
          strokeWidth={2.2}
        />
      );
    case "failed":
      return (
        <CircleAlert
          aria-label={label}
          className={cn(className, "text-dashboard-text-muted")}
          role="img"
        />
      );
    case "working":
      return (
        <Spinner
          aria-label={label}
          className={cn(className, "text-dashboard-text-faint")}
        />
      );
  }
}
