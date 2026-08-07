import { Lightbulb } from "lucide-react";

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
  const rendered = props.part.redacted ? "Reasoning redacted" : props.part.text;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const summary = (
    <>
      <span
        aria-label="Reasoning"
        className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-dashboard-text-muted"
        title="Reasoning"
      >
        <Lightbulb aria-hidden="true" size={14} strokeWidth={1.8} />
      </span>
      <TranscriptHeadingRow
        left={
          searchActive ? (
            <span className="block min-w-0 italic text-dashboard-text-muted">
              Reasoning
            </span>
          ) : (
            <>
              <span className="block min-w-0 truncate italic text-dashboard-text-muted group-open/reasoning:hidden">
                {rendered}
              </span>
              <span className="hidden min-w-0 italic text-dashboard-text-muted group-open/reasoning:inline">
                Reasoning
              </span>
            </>
          )
        }
        right={
          timestamp ? (
            <TranscriptHeadingMeta className="min-w-0 break-words text-xs not-italic text-dashboard-text-muted max-md:hidden">
              {timestamp}
            </TranscriptHeadingMeta>
          ) : undefined
        }
        rightClassName="min-w-0 max-md:hidden"
      />
    </>
  );
  const content = (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2">
      <span aria-hidden="true" />
      <div className="min-w-0 whitespace-pre-wrap break-words py-1 italic text-dashboard-text-muted">
        <HighlightText text={rendered} />
      </div>
    </div>
  );

  if (searchActive) {
    return (
      <div className="py-1.5 text-sm leading-relaxed text-dashboard-text-muted">
        <div className="grid list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2">
          {summary}
        </div>
        {content}
      </div>
    );
  }

  return (
    <details className="group/reasoning py-1.5 text-sm leading-relaxed text-dashboard-text-muted">
      <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 transition-colors hover:text-dashboard-text [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {content}
    </details>
  );
}
