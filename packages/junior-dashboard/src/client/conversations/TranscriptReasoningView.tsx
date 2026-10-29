import { useState } from "react";
import { Lightbulb } from "lucide-react";

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
} from "../components/ui/trace";
import { formatMessageTimestamp } from "../format";
import type { TranscriptViewReasoningPart } from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

/** Render reasoning collapsed with a short preview until expanded or searched. */
export function TranscriptReasoningView(props: {
  part: TranscriptViewReasoningPart;
  timestamp?: number;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [open, setOpen] = useState(false);
  const expanded = searchActive || open;
  const rendered = props.part.redacted ? "Reasoning redacted" : props.part.text;
  const timestamp = formatMessageTimestamp(props.timestamp);

  return (
    <TraceCollapsible
      className="text-xs leading-tight"
      open={expanded}
      onOpenChange={setOpen}
    >
      <TraceCollapsibleTrigger className="-mx-2 w-auto">
        <span className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2">
          <span
            aria-label="Reasoning"
            className="inline-flex size-4 shrink-0 items-center justify-center text-violet-200/80"
            title="Reasoning"
          >
            <Lightbulb aria-hidden="true" size={14} strokeWidth={2} />
          </span>
          <TranscriptHeadingRow
            left={
              expanded ? (
                <span className="block min-w-0 text-dashboard-text-muted">
                  Reasoning
                </span>
              ) : (
                <span className="block min-w-0 truncate italic text-dashboard-text-muted">
                  {rendered}
                </span>
              )
            }
            right={
              timestamp ? (
                <TranscriptHeadingMeta className="min-w-0 break-words text-xs tabular-nums text-dashboard-text-muted max-md:hidden">
                  {timestamp}
                </TranscriptHeadingMeta>
              ) : undefined
            }
            rightClassName="min-w-0 max-md:hidden"
          />
        </span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="px-3 py-2.5">
        <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text-subtle">
          <HighlightText text={rendered} />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
