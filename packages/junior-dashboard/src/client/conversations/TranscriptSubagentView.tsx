import { ChevronRight } from "lucide-react";

import { StatusChip } from "../components/StatusChip";
import { formatElapsedDuration, formatMessageTimestamp } from "../format";
import { cn } from "../styles";
import type { TranscriptViewSubagentPart } from "../types";
import { subagentStatusTone } from "./ConversationChildAgents";
import { HighlightText } from "./transcriptSearch";

/**
 * Render a child agent as a compact card in the transcript stream: name,
 * status, and run time first, then the task title. It opens the child
 * transcript.
 */
export function TranscriptSubagentView(props: {
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
  part: TranscriptViewSubagentPart;
  timestamp?: number;
}) {
  const label = props.part.agentName ?? props.part.subagentKind;
  const headline = props.part.title ?? props.part.task;
  const status = props.part.status;
  const duration = formatElapsedDuration(
    props.timestamp,
    props.part.finishedTimestamp,
  );
  const started =
    typeof props.timestamp === "number"
      ? `Started ${formatMessageTimestamp(props.timestamp)}`
      : undefined;
  const interactive = Boolean(props.onOpenTranscript);

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2 text-xs leading-5">
        <span className="min-w-0 truncate font-sans text-sm font-semibold text-dashboard-text">
          <HighlightText text={label} />
        </span>
        <StatusChip
          className={cn("shrink-0", status === "running" && "animate-pulse")}
          size="compact"
          tone={subagentStatusTone(status)}
        >
          {status}
        </StatusChip>
        {duration ? (
          <span className="shrink-0 tabular-nums text-dashboard-text-muted">
            {duration}
          </span>
        ) : null}
        {interactive ? (
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-dashboard-text-faint transition-colors group-hover/subagent:text-dashboard-text"
          />
        ) : null}
      </span>
      {headline ? (
        <span className="block min-w-0 truncate text-sm leading-snug text-dashboard-text-subtle">
          <HighlightText text={headline} />
        </span>
      ) : null}
    </>
  );
  const frameClass =
    "group/subagent grid w-full min-w-0 max-w-[37.5rem] gap-0.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2 text-left text-inherit";

  if (!props.onOpenTranscript) {
    return (
      <div className={frameClass} title={started}>
        {content}
      </div>
    );
  }

  return (
    <button
      aria-label={`Open ${label} transcript`}
      className={cn(
        frameClass,
        "cursor-pointer transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
      )}
      onClick={() => props.onOpenTranscript?.(props.part)}
      title={started}
      type="button"
    >
      {content}
    </button>
  );
}
