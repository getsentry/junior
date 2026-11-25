import { useContext } from "react";
import { Link } from "react-router";

import { conversationPath } from "../conversations/conversationRoutes";
import { TranscriptActivityNesting } from "../conversations/TranscriptRailEvent";
import { transcriptColumnsClass } from "../conversations/TranscriptRows";
import { cn } from "../styles";
import { formatTime, getDashboardTimeZone } from "../time";
import type { TranscriptViewMessage } from "../types";
import { LeadPage } from "./leadPage";
import { leadWorkStatus } from "./LeadWorkStatus";
import { watchReport } from "./watchReport";

/** Whether a transcript message is an agent update of a watched Conversation. */
export function isConversationWatchReport(
  message: TranscriptViewMessage,
): boolean {
  return watchReport(message) !== undefined;
}

/**
 * Show a status Event of a watched Conversation as one line: its state, its
 * title, and the time. The Lead's reply follows below it.
 */
export function LeadWatchReport(props: {
  message: TranscriptViewMessage;
  timestamp?: number | undefined;
}) {
  const lead = useContext(LeadPage);
  // In an activity group, the icon takes the narrow activity column.
  const nested = useContext(TranscriptActivityNesting);
  const report = watchReport(props.message);
  if (!report) return null;
  const status = leadWorkStatus[report.state];
  const Icon = status.icon;
  const id = props.message.eventIdentifier;
  const title = (id && lead?.conversations.get(id)?.displayTitle) || undefined;
  return (
    <div
      className={cn(
        "grid min-w-0 items-center py-1 font-sans text-xs",
        nested
          ? "grid-cols-[1rem_minmax(0,1fr)] gap-2"
          : transcriptColumnsClass,
      )}
      data-lead-watch-report=""
    >
      <span aria-hidden="true" className="grid place-items-center">
        <Icon className={cn("size-3.5", status.text)} strokeWidth={2} />
      </span>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex min-w-0 items-baseline gap-0.5 text-dashboard-text-muted">
          {id ? (
            // A row past the loaded feed pages has no title, but its id
            // still opens it.
            <Link
              className="min-w-0 truncate font-medium text-dashboard-text no-underline hover:underline"
              to={conversationPath(id)}
            >
              {title ?? "A watched conversation"}
            </Link>
          ) : (
            <span className="min-w-0 truncate">A watched conversation</span>
          )}
          <span className="shrink-0">{` ${report.verb}`}</span>
        </span>
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-dashboard-border-subtle"
        />
        {props.timestamp ? (
          <time
            className="shrink-0 tabular-nums text-dashboard-text-faint"
            dateTime={new Date(props.timestamp).toISOString()}
          >
            {formatTime(props.timestamp, {
              hour: "numeric",
              minute: "2-digit",
              timeZone: getDashboardTimeZone(),
            })}
          </time>
        ) : null}
      </span>
    </div>
  );
}
