import {
  IDLE_CHANGE_DAYS,
  type CodeChangeSummaryReport,
} from "@sentry/junior/api/schema";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../styles";

const DAY_MS = 86_400_000;

/**
 * Whether an open change counts as idle: the same rule as the code
 * overview's `summary.idle`.
 */
export function isIdleChange(
  nowMs: number,
  change: CodeChangeSummaryReport,
): boolean {
  return change.state === "open" && idleDays(nowMs, change) > IDLE_CHANGE_DAYS;
}

/**
 * The last push, review, or comment on a change. Until a code plugin records
 * activity, opening is the last known activity.
 */
export function lastActivity(change: CodeChangeSummaryReport): string {
  return change.lastActivityAt ?? change.openedAt;
}

function idleDays(nowMs: number, change: CodeChangeSummaryReport): number {
  return Math.floor((nowMs - Date.parse(lastActivity(change))) / DAY_MS);
}

/** Time since the last push, review, or comment, colored by idle days. */
export function IdleText(props: {
  change: CodeChangeSummaryReport;
  nowMs: number;
}) {
  const days = idleDays(props.nowMs, props.change);
  const idle = formatSince(props.nowMs, lastActivity(props.change));
  const opened = formatSince(props.nowMs, props.change.openedAt);
  const touched =
    props.change.lastActivityAt !== undefined &&
    props.change.lastActivityAt > props.change.openedAt;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            // Idle past the summary's idle rule turns red; 4 days up to it,
            // amber.
            className={cn(
              days > IDLE_CHANGE_DAYS && "font-medium text-rose-300",
              days >= 4 &&
                days <= IDLE_CHANGE_DAYS &&
                "font-medium text-amber-300",
            )}
          />
        }
      >
        {idle}
      </TooltipTrigger>
      <TooltipContent size="compact">
        {/* PRs opened before tracking started can have untracked activity. */}
        {touched
          ? `Last activity ${idle} ago · opened ${opened} ago`
          : `Opened ${opened} ago`}
      </TooltipContent>
    </Tooltip>
  );
}

function formatSince(nowMs: number, at: string): string {
  const minutes = Math.max(1, Math.floor((nowMs - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / (24 * 60));
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}
