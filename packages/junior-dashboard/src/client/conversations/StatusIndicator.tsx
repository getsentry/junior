import { cn } from "../styles";
import type { Conversation } from "../types";

/** What a status indicator shows: a yellow dot, a pulsing dot, or a ring. */
export const STATUS_INDICATOR_STATES = [
  "needs_you",
  "working",
  "done",
] as const;

type StatusIndicatorState = (typeof STATUS_INDICATOR_STATES)[number];

/**
 * The facts that decide the indicator of a Conversation, a Thread, a child
 * agent, or a Space. Each surface maps its own data to these.
 */
type StatusIndicatorSource = {
  archivedAt?: string | null | undefined;
  latestTurnFailed?: boolean | undefined;
  treeState?: Conversation["treeState"];
  turnActive?: boolean | undefined;
  /** An Inbox ask waits on the viewer. */
  waitsOnViewer?: boolean | undefined;
};

/**
 * Pick the indicator for today's status data. Every status indicator, sort,
 * and filter reads it, so a change to the statuses changes only this. An
 * archived row shows none.
 */
export function statusIndicatorState(
  source: StatusIndicatorSource,
): StatusIndicatorState | undefined {
  if (source.archivedAt) return undefined;
  if (
    source.treeState === "needs_you" ||
    source.waitsOnViewer ||
    source.latestTurnFailed
  ) {
    return "needs_you";
  }
  if (source.treeState === "working" || source.turnActive) return "working";
  return "done";
}

/**
 * Pick the indicator of a Space row. A Space whose Threads need nothing
 * shows none (`design/spaces.md`).
 */
export function spaceIndicatorState(
  space: StatusIndicatorSource,
): StatusIndicatorState | undefined {
  const state = statusIndicatorState(space);
  return state === "done" ? undefined : state;
}

const LABELS: Record<StatusIndicatorState, string> = {
  done: "Done",
  needs_you: "Waiting on you",
  working: "Working",
};

const DOT_CLASSES: Record<StatusIndicatorState, string> = {
  done: "border-[1.5px] border-dashboard-text-faint",
  needs_you: "bg-yellow-400 light:bg-yellow-500",
  working: "animate-pulse bg-dashboard-text-faint motion-reduce:animate-none",
};

/**
 * Show the status of a Conversation, Thread, child agent, or Space as one
 * dot in a 0.875rem box, the size of the icons beside it. Hover shows the
 * label.
 */
export function StatusIndicator(props: {
  className?: string;
  state: StatusIndicatorState | undefined;
}) {
  if (!props.state) return null;
  const label = LABELS[props.state];
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        props.className,
      )}
      role="img"
      title={label}
    >
      <span className={cn("size-2 rounded-full", DOT_CLASSES[props.state])} />
    </span>
  );
}
