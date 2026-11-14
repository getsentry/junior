import { ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { dashboardDisclosureChevronClass } from "../styles";
import { formatCompactNumber, formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";
import { DisplayText } from "../display-text/DisplayText";

/** Render a structural context change from the privacy-safe event API. */
export function TranscriptContextEventView(props: {
  part: TranscriptViewContextEventPart;
  timestamp?: number | undefined;
}) {
  const event = props.part.event;
  const compactionDetail = event.details
    ? ` at approximately ${formatCompactNumber(event.details.estimatedInputTokens)} estimated tokens`
    : "";
  const compactionModel = event.modelId ? ` using ${event.modelId}` : "";
  return (
    <article className="min-w-0 py-0.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong className="font-sans text-xs font-semibold text-amber-100">
          Context compacted
        </strong>
        {typeof props.timestamp === "number" ? (
          <span className="text-xs text-dashboard-text-muted">
            {formatMessageTimestamp(props.timestamp)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-dashboard-text-muted">
        {`Earlier context was summarized${compactionDetail}${compactionModel} before execution continued.`}
      </div>
      {event.summary ? (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="group flex cursor-pointer select-none items-center gap-1 text-xs font-medium text-dashboard-text-muted focus-visible:outline-2 focus-visible:outline-dashboard-focus">
            <ChevronRight
              aria-hidden="true"
              className={dashboardDisclosureChevronClass}
            />
            Continuation summary
          </CollapsibleTrigger>
          <CollapsibleContent hiddenUntilFound>
            <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-dashboard-text-muted">
              <DisplayText
                mentions={props.part.mentions}
                text={event.summary}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </article>
  );
}
