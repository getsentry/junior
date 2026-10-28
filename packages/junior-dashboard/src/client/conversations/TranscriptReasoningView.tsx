import { Lightbulb } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewReasoningPart } from "../types";
import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { TranscriptSummary } from "./TranscriptSummary";
import { transcriptActivityBodyClass } from "./ToolFrame";

/** Render reasoning collapsed with a short preview until expanded or searched. */
export function TranscriptReasoningView(props: {
  part: TranscriptViewReasoningPart;
  timestamp?: number;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const rendered = props.part.redacted ? "Reasoning redacted" : props.part.text;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const summary = (
    <>
      <span
        aria-label="Reasoning"
        className="inline-flex size-4 shrink-0 items-center justify-center text-violet-200/80"
        title="Reasoning"
      >
        <Lightbulb aria-hidden="true" size={14} strokeWidth={2} />
      </span>
      <TranscriptHeadingRow
        left={
          searchActive ? (
            <span className="block min-w-0 text-dashboard-text-muted">
              Reasoning
            </span>
          ) : (
            <>
              <span className="block min-w-0 truncate italic text-dashboard-text-muted group-open/reasoning:hidden">
                {rendered}
              </span>
              <span className="hidden min-w-0 text-dashboard-text-muted group-open/reasoning:inline">
                Reasoning
              </span>
            </>
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
    </>
  );
  const content = (
    <div className={cn(transcriptActivityBodyClass, "px-3 py-2.5")}>
      <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text-subtle">
        <HighlightText text={rendered} />
      </div>
    </div>
  );

  if (searchActive) {
    return (
      <div className={reasoningFrameClass()}>
        <div className="grid list-none grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 py-1.5">
          {summary}
        </div>
        {content}
      </div>
    );
  }

  return (
    <details className={cn("group/reasoning", reasoningFrameClass())}>
      <TranscriptSummary className="-mx-2 grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-2">
        {summary}
      </TranscriptSummary>
      {content}
    </details>
  );
}

function reasoningFrameClass(): string {
  return "min-w-0 text-xs leading-tight";
}
