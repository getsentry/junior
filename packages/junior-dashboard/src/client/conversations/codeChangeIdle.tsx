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
import { formatDuration } from "../time";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// The last push, review, or comment on a change. Until a code plugin records
// activity, opening is the last known activity.
function lastActivity(change: CodeChangeSummaryReport): string {
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
  // Ages start at `1m`, so a change from seconds ago reads `1m`, not `12s`.
  const since = (at: string) =>
    formatDuration(Math.max(MINUTE_MS, props.nowMs - Date.parse(at)), 1);
  const idle = since(lastActivity(props.change));
  const opened = since(props.change.openedAt);
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
